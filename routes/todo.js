const router = require("express").Router();
const Todo = require("../models/Todo");
const auth = require("../middleware/auth");
const logOperation = require("../utils/audit"); // 引入你的日志工具

/**
 * GET /
 * 获取愿望清单
 * 排序策略：优先按 order (置顶权重) 降序，其次按 timestamp (创建时间) 倒序
 */
router.get("/", auth, async (req, res) => {
  try {
    const list = await Todo.find()
      .sort({ order: -1, timestamp: -1 }); // 先看权重，再看时间
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /
 * 创建新愿望
 */
router.post("/", auth, async (req, res) => {
  try {
    // 提取新旧所有可能的字段
    const { todo, description, targetDate, images, order } = req.body;
    
    // 生成旧系统兼容的时间戳
    const now = new Date();
    const timestamp = Date.now(); // 保持旧有的数字/字符串时间戳格式

    const newTodo = new Todo({
      todo,
      description: description || "",
      targetDate: targetDate || null,
      images: images || [],
      order: order || 0,
      
      // --- 默认状态初始化 ---
      status: 'todo',
      done: false,
      
      // --- 兼容字段填充 ---
      timestamp: timestamp,
      create_date: now.toISOString()
    });

    await newTodo.save();

    // 🔥 日志：许下愿望
    logOperation({
      operatorId: req.user.id,
      action: "CREATE_WISH",
      target: todo,
      details: { 
        id: newTodo._id, 
        has_target_date: !!targetDate 
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新列表
    const allTodo = await Todo.find().sort({ order: -1, timestamp: -1 });
    res.json(allTodo);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * POST /done/:id 
 * (也可以叫 PUT /:id，保持你的旧路由习惯)
 * 功能：更新状态、打卡配图、修改内容、置顶
 */
router.post("/done/:id", auth, async (req, res) => {
  const { 
    // 旧字段
    done, 
    todo, 
    // 新字段
    status, 
    description, 
    images, 
    targetDate, 
    order 
  } = req.body;

  try {
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

    // 2. --- 核心状态同步逻辑 (Sync Logic) ---
    // 场景 A: 新前端传了 status ('todo', 'in_progress', 'done')
    if (status !== undefined) {
      updateFields.status = status;
      
      // 同步给旧字段 done
      if (status === 'done') {
        updateFields.done = true;
        updateFields.complete_date = new Date().toISOString();
      } else {
        updateFields.done = false;
        // 如果是从 done 变回其他状态，可能需要清除 complete_date，视业务需求而定
        // updateFields.complete_date = null; 
      }
    } 
    // 场景 B: 旧前端只传了 done (true/false)
    else if (done !== undefined) {
      updateFields.done = done;
      
      // 同步给新字段 status
      if (done === true || done === 'true' || done === 1) {
        updateFields.status = 'done';
        updateFields.complete_date = new Date().toISOString();
      } else {
        // 如果取消完成，默认回退到 todo，除非当前已经是 in_progress (这点很难判断，所以简单处理回退到 todo)
        updateFields.status = 'todo';
      }
    }

    // 3. --- 执行更新 ---
    const updatedTodo = await Todo.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true } // 返回更新后的文档
    );

    if (!updatedTodo) return res.status(404).send("Todo not found");

    // 4. --- 智能日志记录 ---
    let action = "UPDATE_WISH"; // 默认动作

    // 根据最终状态判断动作类型
    if (updatedTodo.status === 'done' && (!status || status === 'done')) {
        action = "FULFILL_WISH"; // 达成
    } else if (updatedTodo.status === 'in_progress') {
        action = "START_WISH";   // 开始
    } else if (updatedTodo.status === 'todo' && (done === false)) {
        action = "RESET_WISH";   // 重置
    } else if (images && images.length > 0) {
        action = "UPLOAD_EVIDENCE"; // 补充证据
    }

    logOperation({
      operatorId: req.user.id,
      action: action,
      target: updatedTodo.todo,
      details: {
        ...logDetails,
        id: updatedTodo._id,
        status_after: updatedTodo.status,
        done_after: updatedTodo.done
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 5. --- 返回列表 ---
    const allTodos = await Todo.find().sort({ order: -1, timestamp: -1 });
    res.json(allTodos);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * GET /done/:id
 * 获取单条详情 (兼容旧接口)
 */
router.get("/done/:id", async (req, res) => {
  try {
    const item = await Todo.findById(req.params.id);
    res.json(item);
  } catch (err) {
    res.status(404).json({ msg: "Item not found" });
  }
});

/**
 * DELETE /:id
 * 删除愿望
 */
router.delete("/:id", auth, async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (!todo) return res.status(404).json({ msg: "Todo not found" });

    await todo.deleteOne();

    // 🔥 日志
    logOperation({
      operatorId: req.user.id,
      action: "DELETE_WISH",
      target: todo.todo,
      details: { id: req.params.id },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

module.exports = router;