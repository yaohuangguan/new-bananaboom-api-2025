import { Router } from 'express';
import cronParser from 'cron-parser'; // 🔥 需 npm install cron-parser
import auth from '../middleware/auth.js';
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import logOperation from '../utils/audit.js';
import { NEW_NOTIFICATION } from '../socket/events.js';
import { sendBarkNotification } from '../utils/bark.js'

const router = Router();

/**
 * =================================================================
 * 🛠 辅助函数：获取当前用户的查询范围
 * =================================================================
 * 逻辑：Super Admin 可见家庭所有成员的任务；普通用户仅见自己。
 */
async function getQueryForUser(user) {
  if (user.role === 'super_admin') {
    const familyMembers = await User.find({ role: 'super_admin' }).select('_id');
    const familyIds = familyMembers.map((u) => u._id);
    return { user: { $in: familyIds } };
  } else {
    return { user: user.id };
  }
}

/**
 * =================================================================
 * 🛠 辅助函数：计算下一次提醒时间 (带时区感知)
 * =================================================================
 * @param {string} recurrenceRule - 规则 ("interval:30m" 或 "0 8 * * *")
 * @param {Date} baseTime - 基础时间 (通常是 now)
 * @param {string} userTimezone - 用户时区 (如 "Asia/Shanghai")
 */
function calculateNextRun(recurrenceRule, baseTime = new Date(), userTimezone = 'Asia/Shanghai') {
  if (!recurrenceRule) return null;

  try {
    // 模式 A: 简单间隔 (绝对时间，不受时区影响)
    // 格式: "interval:30m", "interval:2h"
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

    // 模式 B: Cron 表达式 (依赖时区)
    // 格式: "0 9 * * *"
    const interval = cronParser.parseExpression(recurrenceRule, {
      currentDate: baseTime,
      tz: userTimezone // 🔥 关键：告诉解析器这是"哪里的"9点
    });
    return interval.next().toDate();
  } catch (err) {
    console.error('[TimeCalc] Error:', err.message);
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

    const allTodo = await Todo.find(query)
      // 🔥 填充创建者信息
      .populate('user', 'displayName photoURL email')
      // 🔥 填充通知对象信息 (前端可展示一排小头像)
      .populate('notifyUsers', 'displayName photoURL')
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
 * 创建新任务
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
      type,       // 'wish' 或 'routine'
      recurrence, // 'interval:30m' 或 '0 8 * * *'
      remindAt,   // 指定的首次提醒时间
      notifyUsers,// ID 数组
      bark        // 🔥 新增：Bark 高级配置 { sound, level, icon ... }
    } = req.body;

    const taskType = type || 'wish';
    let finalRemindAt = remindAt;

    // 1. 处理通知人逻辑
    // 如果前端传了非空数组，用前端的；否则默认只通知创建者
    let finalNotifyUsers = [];
    if (notifyUsers && Array.isArray(notifyUsers) && notifyUsers.length > 0) {
      finalNotifyUsers = notifyUsers;
    } else {
      finalNotifyUsers = [req.user.id];
    }

    // 2. 智能时间逻辑 (Routine 自动计算初始时间)
    // 需要用到用户的 timezone
    if (taskType === 'routine' && !finalRemindAt && recurrence) {
      const userTZ = req.user.timezone || 'Asia/Shanghai';
      finalRemindAt = calculateNextRun(recurrence, new Date(), userTZ);
    }

    const newTodo = new Todo({
      user: req.user.id,
      
      // 通知对象
      notifyUsers: finalNotifyUsers,

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
      isNotified: false, 

      // 🔥 Bark 配置 (存入数据库)
      bark: bark || {},

      // 愿望字段
      targetDate: targetDate || null,
      
      // 默认状态
      status: 'todo',
      done: false,
      
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
        recurrence: recurrence,
        notify_count: finalNotifyUsers.length
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新列表
    const query = await getQueryForUser(req.user);
    const allTodo = await Todo.find(query)
      .populate('user', 'displayName photoURL')
      .populate('notifyUsers', 'displayName photoURL')
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
 * 更新任务详情
 * -----------------------------------------------------------------
 */
router.post('/done/:id', auth, async (req, res) => {
  const { 
    done, todo, status, description, images, targetDate, order, 
    remindAt, recurrence, type, notifyUsers, bark // 🔥
  } = req.body;

  try {
    const todoItem = await Todo.findById(req.params.id);
    if (!todoItem) return res.status(404).send('Todo not found');

    // 权限检查 (自己 OR 家庭管理员)
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
    
    // 更新通知人列表
    if (notifyUsers !== undefined && Array.isArray(notifyUsers)) {
      updateFields.notifyUsers = notifyUsers;
    }

    // 🔥 更新 Bark 配置 (直接覆盖)
    if (bark !== undefined) {
      updateFields.bark = bark;
    }

    // 如果更新了提醒时间，重置通知状态
    if (remindAt !== undefined) {
      updateFields.remindAt = remindAt;
      updateFields.isNotified = false; 
    }

    // 3. --- 状态同步逻辑 ---
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
    )
    .populate('user', 'displayName photoURL')
    .populate('notifyUsers', 'displayName photoURL'); // 带回最新通知人信息

    // 5. --- 日志 ---
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
      .populate('notifyUsers', 'displayName photoURL')
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
 * 逻辑：不完成任务，仅将时间推迟到下一次循环
 */
router.post('/routine/:id/check', auth, async (req, res) => {
  try {
    // 🔥 需要 populate user 以获取 timezone
    const todo = await Todo.findById(req.params.id).populate('user');
    
    if (!todo) return res.status(404).json({ msg: 'Not found' });

    if (todo.type !== 'routine' || !todo.recurrence) {
      return res.status(400).json({ msg: '此任务不是循环例行任务' });
    }

    // 🔥 核心：基于 [当前时间] + [用户时区] 重新计算下一次
    const userTZ = todo.user.timezone || 'Asia/Shanghai';
    const nextTime = calculateNextRun(todo.recurrence, new Date(), userTZ);

    if (nextTime) {
      todo.remindAt = nextTime;
      todo.isNotified = false; // 重置
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
    const item = await Todo.findById(req.params.id)
      .populate('user', 'displayName photoURL')
      .populate('notifyUsers', 'displayName photoURL'); // 详情页也要看到通知了谁
      
    if (!item) return res.status(404).json({ msg: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(404).json({ msg: 'Item not found' });
  }
});

/**
 * -----------------------------------------------------------------
 * POST /api/todos/routine/:id/test
 * 立即测试发送通知 (不修改任务时间)
 * -----------------------------------------------------------------
 * 用途：用户配置好 Bark 或 Socket 后，点一下测试看看能不能收到
 */
router.post('/routine/:id/test', auth, async (req, res) => {
  try {
    const io = req.app.get('socketio');

    // 1. 查任务 (必须 populate notifyUsers 且拿出 barkUrl)
    const todo = await Todo.findById(req.params.id)
      .populate('user', 'displayName photoURL')
      .populate({
        path: 'notifyUsers',
        select: 'displayName email +barkUrl' // 🔥 必须显式 +barkUrl
      });

    if (!todo) return res.status(404).json({ msg: 'Task not found' });

    // 权限检查
    const isOwner = todo.user._id.toString() === req.user.id;
    const isFamilyAdmin = req.user.role === 'super_admin';
    if (!isOwner && !isFamilyAdmin) {
      return res.status(403).json({ msg: '无权操作' });
    }

    // 2. 准备推送内容 (加上 [测试] 前缀区分)
    const title = `🔔 [测试] ${todo.todo}`;
    const body = todo.description || '这是一条测试推送，请检查铃声和图标配置是否正确。';

    // 3. 确定发送目标
    // 逻辑：如果任务配置了通知人，就发给这些人；否则只发给当前请求测试的人(防止打扰别人)
    let targets = [];
    if (todo.notifyUsers && todo.notifyUsers.length > 0) {
      targets = todo.notifyUsers;
    } else {
      // 兜底：如果没配通知人，尝试发给任务所有者
      // 但因为上面 populate user 没加 barkUrl，这里其实拿不到。
      // 所以我们做一个特殊的处理：把当前发起请求的 req.user (带 barkUrl) 临时加进去
      // 前提是 auth 中间件里 req.user 带了 barkUrl (通常没有 select +barkUrl)
      // 所以最稳妥的是：只处理 notifyUsers，或者重新查一下当前用户
      const currentUser = await User.findById(req.user.id).select('+barkUrl');
      targets = [currentUser];
    }

    console.log(`🧪 执行测试推送: [${title}] -> ${targets.length} 人`);

    const socketPayload = {
      type: 'system_reminder',
      content: `${title}: ${body}`,
      taskId: todo._id,
      timestamp: new Date(),
      fromUser: { displayName: '系统测试', id: 'system' }
    };

    // 4. 执行发送循环
    const results = [];
    for (const target of targets) {
      const result = { user: target.displayName, bark: false, socket: false };

      // A. Socket
      if (io && target._id) {
        io.to(target._id.toString()).emit(NEW_NOTIFICATION, socketPayload);
        result.socket = true;
      }

      // B. Bark (复用 Scheduler 里的逻辑)
      if (target.barkUrl) {
        await sendBarkNotification(target.barkUrl, title, body, todo.bark);
        result.bark = true;
      }
      
      results.push(result);
    }

    // 5. 记录一条测试日志 (可选)
    /*
    logOperation({
      operatorId: req.user.id,
      action: 'TEST_ROUTINE',
      target: todo.todo,
      details: { results },
      ip: req.ip,
      io: io
    });
    */

    res.json({ success: true, msg: '测试消息已发送', results });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
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