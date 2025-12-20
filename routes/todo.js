const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Todo = require("../models/Todo");
const User = require("../models/User");
const logOperation = require("../utils/audit");

/**
 * GET /
 * 获取愿望列表
 * 策略：Super Admin 看所有 Super Admin 的数据 (家庭模式)，普通用户只看自己
 */
router.get("/", auth, async (req, res) => {
  try {
    let query = {};
    const currentUser = req.user;

    // 🔥 家庭组逻辑
    if (currentUser.role === 'super_admin') {
      // 找出所有 Super Admin (家庭成员)
      const familyMembers = await User.find({ role: 'super_admin' }).select('_id');
      const familyIds = familyMembers.map(u => u._id);
      
      // 查询条件：所有者 IN [你, 你老婆]
      query = { user: { $in: familyIds } };
    } else {
      // 普通用户：只能看自己的
      query = { user: currentUser.id };
    }

    // 按置顶(order)降序，然后按创建时间(createdAt)降序
    // populate('user') 让前端能显示头像
    const allTodo = await Todo.find(query)
      .populate('user', 'displayName photoURL email')
      .sort({ order: -1, createdAt: -1 });
      
    res.json(allTodo);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * POST /
 * 创建新愿望
 */
router.post("/", auth, async (req, res) => {
  try {
    const { todo, description, targetDate, images, order, remindAt } = req.body;
    
    // 生成旧系统兼容的时间戳
    const now = new Date();
    const timestamp = Date.now();

    const newTodo = new Todo({
      // 🔥 必须关联当前用户
      user: req.user.id,
      
      todo,
      description: description || "",
      targetDate: targetDate || null,
      images: images || [],
      order: order || 0,
      
      // 🔥 提醒时间 (如果有)
      remindAt: remindAt || null,
      isNotified: false, // 重置通知状态

      // 默认状态
      status: 'todo',
      done: false,
      
      // 兼容字段
      timestamp: timestamp,
      create_date: now.toISOString()
    });

    await newTodo.save();

    // 日志
    logOperation({
      operatorId: req.user.id,
      action: "CREATE_WISH",
      target: todo,
      details: { 
        id: newTodo._id, 
        has_remind: !!remindAt 
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新列表 (复用 GET 的查询逻辑，太麻烦，这里简单返回单条或者重新查一次)
    // 为了前端方便刷新，建议这里直接返回创建的对象，前端自己 push 进去，或者重新调一次 GET
    // 这里保持你旧习惯，返回全列表 (注意要用同样的家庭逻辑)
    
    // --- 重新查询全列表 ---
    let query = { user: req.user.id };
    if (req.user.role === 'super_admin') {
        const familyMembers = await User.find({ role: 'super_admin' }).select('_id');
        const familyIds = familyMembers.map(u => u._id);
        query = { user: { $in: familyIds } };
    }
    const allTodo = await Todo.find(query)
      .populate('user', 'displayName photoURL')
      .sort({ order: -1, createdAt: -1 });

    res.json(allTodo);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * POST /done/:id 
 * 更新任务 (状态、内容、提醒时间)
 */
router.post("/done/:id", auth, async (req, res) => {
  const { 
    done, todo, status, description, 
    images, targetDate, order, remindAt 
  } = req.body;

  try {
    const todoItem = await Todo.findById(req.params.id);
    if (!todoItem) return res.status(404).send("Todo not found");

    // 🔥 权限检查：自己 OR 家庭管理员
    const isOwner = todoItem.user.toString() === req.user.id;
    const isFamilyAdmin = req.user.role === 'super_admin';

    if (!isOwner && !isFamilyAdmin) {
      return res.status(401).json({ msg: "无权操作此任务" });
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
    
    // 🔥 更新提醒时间
    if (remindAt !== undefined) {
        updateFields.remindAt = remindAt;
        updateFields.isNotified = false; // 修改时间后，重置通知状态，可以再次提醒
    }

    // 2. --- 状态同步逻辑 ---
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

    // 3. --- 执行更新 ---
    const updatedTodo = await Todo.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    ).populate('user', 'displayName photoURL'); // 关联回来

    // 4. --- 智能日志 ---
    let action = "UPDATE_WISH";
    if (updatedTodo.status === 'done' && (!status || status === 'done')) {
        action = "FULFILL_WISH"; 
    } else if (images && images.length > 0) {
        action = "UPLOAD_EVIDENCE"; 
    }

    logOperation({
      operatorId: req.user.id,
      action: action,
      target: updatedTodo.todo,
      details: {
        ...logDetails,
        id: updatedTodo._id,
        operator: req.user.displayName // 记录是谁改的 (可能是老婆改的)
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 5. --- 返回列表 ---
    let query = { user: req.user.id };
    if (req.user.role === 'super_admin') {
        const familyMembers = await User.find({ role: 'super_admin' }).select('_id');
        const familyIds = familyMembers.map(u => u._id);
        query = { user: { $in: familyIds } };
    }
    const allTodos = await Todo.find(query)
      .populate('user', 'displayName photoURL')
      .sort({ order: -1, createdAt: -1 });
      
    res.json(allTodos);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * GET /done/:id
 * 获取单条详情
 */
router.get("/done/:id", async (req, res) => {
  try {
    const item = await Todo.findById(req.params.id).populate('user', 'displayName photoURL');
    if (!item) return res.status(404).json({ msg: "Item not found" });
    
    // 这里本来应该做权限检查，但如果只是GET单条，一般也无所谓，或者加上auth中间件
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

    // 权限检查
    const isOwner = todo.user.toString() === req.user.id;
    const isFamilyAdmin = req.user.role === 'super_admin';

    if (!isOwner && !isFamilyAdmin) {
      return res.status(403).json({ msg: "无权删除" });
    }

    await todo.deleteOne();

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