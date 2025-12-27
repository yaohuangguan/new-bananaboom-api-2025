import { Router } from 'express';
import cronParser from 'cron-parser'; // 🔥 用于解析 Cron 表达式，需 npm install cron-parser
import auth from '../middleware/auth.js';
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import logOperation from '../utils/audit.js';

const router = Router();

/**
 * =================================================================
 * 辅助函数：获取当前用户的查询范围
 * =================================================================
 * 逻辑：
 * 1. 如果是 Super Admin (家庭管理员)，可以看到所有 Super Admin (家庭成员) 的任务。
 * 2. 如果是普通用户，只能看到自己的。
 */
async function getQueryForUser(user) {
  if (user.role === 'super_admin') {
    // 找出所有家庭成员 (角色为 super_admin 的人)
    const familyMembers = await User.find({ role: 'super_admin' }).select('_id');
    const familyIds = familyMembers.map((u) => u._id);
    return { user: { $in: familyIds } };
  } else {
    // 普通用户只能看自己
    return { user: user.id };
  }
}

/**
 * =================================================================
 * 辅助函数：计算下一次提醒时间
 * =================================================================
 * 用于 Routine 创建时自动计算初始时间，或打卡后计算下一次
 */
function calculateNextRun(recurrenceRule, baseTime = new Date()) {
  if (!recurrenceRule) return null;

  try {
    // 模式 A: 简单间隔 (自定义格式: "interval:30m")
    if (recurrenceRule.startsWith('interval:')) {
      const timeStr = recurrenceRule.split(':')[1];
      const unit = timeStr.slice(-1); // 'm', 'h', 'd'
      const value = parseInt(timeStr.slice(0, -1));
      
      const msMap = { 
        m: 60 * 1000, 
        h: 60 * 60 * 1000, 
        d: 24 * 60 * 60 * 1000 
      };
      
      return new Date(baseTime.getTime() + value * (msMap[unit] || 0));
    }

    // 模式 B: Cron 表达式 (标准格式: "0 9 * * *")
    const interval = cronParser.parseExpression(recurrenceRule, {
      currentDate: baseTime
    });
    return interval.next().toDate();
  } catch (err) {
    console.error('Time calculation error:', err.message);
    return null;
  }
}

/**
 * -----------------------------------------------------------------
 * GET /api/todos
 * 获取任务列表
 * -----------------------------------------------------------------
 */
router.get('/', auth, async (req, res) => {
  try {
    const query = await getQueryForUser(req.user);

    // 按置顶降序，然后按创建时间降序
    const allTodo = await Todo.find(query)
      .populate('user', 'displayName photoURL email')
      .sort({ order: -1, createdAt: -1 });

    res.json(allTodo);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

/**
 * -----------------------------------------------------------------
 * POST /api/todos
 * 创建新任务 (支持 愿望 Wish 和 例行 Routine)
 * -----------------------------------------------------------------
 */
router.post('/', auth, async (req, res) => {
  try {
    const { 
      todo, 
      description, 
      targetDate, 
      images, 
      order, 
      // 🔥 新增字段
      type,         // 'wish' 或 'routine'
      recurrence,   // 'interval:30m' 或 '0 8 * * *'
      remindAt      // 指定的首次提醒时间
    } = req.body;

    const taskType = type || 'wish';
    let finalRemindAt = remindAt;

    // 🔥 智能时间逻辑：
    // 如果是 Routine (例行)，且用户没选具体时间，但给了循环规则
    // 系统自动计算 "下一次" 时间作为初始提醒时间
    if (taskType === 'routine' && !finalRemindAt && recurrence) {
      finalRemindAt = calculateNextRun(recurrence, new Date());
    }

    const newTodo = new Todo({
      user: req.user.id,
      
      // 基础信息
      todo,
      description: description || '',
      images: images || [],
      order: order || 0,

      // 类型与循环
      type: taskType,
      recurrence: taskType === 'routine' ? recurrence : null,

      // 提醒设置
      remindAt: finalRemindAt || null,
      isNotified: false, // 新建任务肯定还没通知

      // 愿望字段
      targetDate: targetDate || null,
      
      // 默认状态
      status: 'todo',
      done: false,
      
      // 兼容旧字段
      timestamp: Date.now(),
      create_date: new Date().toISOString()
    });

    await newTodo.save();

    // 记录审计日志
    logOperation({
      operatorId: req.user.id,
      action: taskType === 'routine' ? 'CREATE_ROUTINE' : 'CREATE_WISH',
      target: todo,
      details: {
        id: newTodo._id,
        has_remind: !!finalRemindAt,
        recurrence: recurrence
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新的完整列表
    const query = await getQueryForUser(req.user);
    const allTodo = await Todo.find(query)
      .populate('user', 'displayName photoURL')
      .sort({ order: -1, createdAt: -1 });

    res.json(allTodo);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

/**
 * -----------------------------------------------------------------
 * POST /api/todos/done/:id
 * 更新任务详情 (状态、内容、提醒时间、循环规则)
 * -----------------------------------------------------------------
 */
router.post('/done/:id', auth, async (req, res) => {
  const { 
    done, todo, status, description, images, targetDate, order, 
    // 🔥 新增
    remindAt, recurrence, type
  } = req.body;

  try {
    const todoItem = await Todo.findById(req.params.id);
    if (!todoItem) return res.status(404).send('Todo not found');

    // 权限检查
    const isOwner = todoItem.user.toString() === req.user.id;
    const isFamilyAdmin = req.user.role === 'super_admin';
    if (!isOwner && !isFamilyAdmin) {
      return res.status(401).json({ msg: '无权操作此任务' });
    }

    const updateFields = {};
    const logDetails = {};

    // 1. --- 基础内容更新 ---
    if (todo !== undefined) updateFields.todo = todo;
    if (description !== undefined) updateFields.description = description;
    if (targetDate !== undefined) updateFields.targetDate = targetDate;
    if (order !== undefined) updateFields.order = order;
    if (images !== undefined) {
      updateFields.images = images;
      logDetails.image_count = images.length;
    }
    if (type !== undefined) updateFields.type = type;

    // 2. --- 提醒与循环更新 ---
    if (recurrence !== undefined) updateFields.recurrence = recurrence;

    // 🔥 如果更新了提醒时间
    if (remindAt !== undefined) {
      updateFields.remindAt = remindAt;
      // 只要手动改了时间，就重置通知状态，让 Scheduler 可以再次抓取它
      updateFields.isNotified = false; 
    }

    // 3. --- 状态同步逻辑 (Status vs Done) ---
    if (status !== undefined) {
      updateFields.status = status;
      if (status === 'done') {
        updateFields.done = true;
        updateFields.complete_date = new Date().toISOString();
      } else {
        updateFields.done = false;
      }
    } else if (done !== undefined) {
      updateFields.done = done;
      if (done === true || done === 'true' || done === 1) {
        updateFields.status = 'done';
        updateFields.complete_date = new Date().toISOString();
      } else {
        updateFields.status = 'todo';
      }
    }

    // 4. --- 执行更新 ---
    const updatedTodo = await Todo.findByIdAndUpdate(
      req.params.id, 
      { $set: updateFields }, 
      { new: true }
    ).populate('user', 'displayName photoURL');

    // 5. --- 智能日志 ---
    let action = 'UPDATE_TASK';
    if (updatedTodo.status === 'done' && (!status || status === 'done')) {
      action = 'FULFILL_WISH';
    }

    logOperation({
      operatorId: req.user.id,
      action: action,
      target: updatedTodo.todo,
      details: {
        ...logDetails,
        id: updatedTodo._id,
        operator: req.user.name
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 6. --- 返回列表 ---
    const query = await getQueryForUser(req.user);
    const allTodos = await Todo.find(query)
      .populate('user', 'displayName photoURL')
      .sort({ order: -1, createdAt: -1 });

    res.json(allTodos);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

/**
 * -----------------------------------------------------------------
 * POST /api/todos/routine/:id/check
 * Routine 打卡专用接口
 * -----------------------------------------------------------------
 * 场景：提醒喝水，我喝完了，点一下"打卡"。
 * 逻辑：立即计算下一次提醒时间并更新，不改变完成状态（Routine 永远是 todo）。
 */
router.post('/routine/:id/check', auth, async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (!todo) return res.status(404).json({ msg: 'Not found' });

    // 只有 Routine 类型才有意义
    if (todo.type !== 'routine' || !todo.recurrence) {
      return res.status(400).json({ msg: '此任务不是循环例行任务' });
    }

    // 🔥 核心：基于 [当前时间] 重新计算下一次
    // 比如：原定14:00喝水，我拖到14:15才喝并打卡。
    // 如果是 interval:1h，下一次应该是 15:15，而不是 15:00。
    const nextTime = calculateNextRun(todo.recurrence, new Date());

    if (nextTime) {
      todo.remindAt = nextTime;
      todo.isNotified = false; // 重置，等待下次通知
      await todo.save();
      
      res.json({ success: true, nextRun: nextTime, msg: '打卡成功，下次提醒已更新' });
    } else {
      res.status(400).json({ msg: '无法计算下一次时间' });
    }

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

/**
 * -----------------------------------------------------------------
 * GET /api/todos/done/:id
 * 获取单条详情
 * -----------------------------------------------------------------
 */
router.get('/done/:id', async (req, res) => {
  try {
    const item = await Todo.findById(req.params.id).populate('user', 'displayName photoURL');
    if (!item) return res.status(404).json({ msg: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(404).json({ msg: 'Item not found' });
  }
});

/**
 * -----------------------------------------------------------------
 * DELETE /api/todos/:id
 * 删除任务
 * -----------------------------------------------------------------
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (!todo) return res.status(404).json({ msg: 'Todo not found' });

    const isOwner = todo.user.toString() === req.user.id;
    const isFamilyAdmin = req.user.role === 'super_admin';

    if (!isOwner && !isFamilyAdmin) {
      return res.status(403).json({ msg: '无权删除' });
    }

    await todo.deleteOne();

    logOperation({
      operatorId: req.user.id,
      action: 'DELETE_TASK',
      target: todo.todo,
      details: { id: req.params.id },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

export default router;