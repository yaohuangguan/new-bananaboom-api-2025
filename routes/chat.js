const express = require("express");
const router = express.Router();
const Chat = require("../models/Chat"); // 引用你的 Chat 模型
const auth = require("../middleware/auth"); // 引用鉴权中间件
const mongoose = require('mongoose')
// ==========================================
// 1. 获取群聊/房间历史记录 (Public)
// ==========================================
// @route   GET api/chat/public/:roomName
// @desc    获取指定房间（如 'public', 'gaming'）的历史记录
// @access  Private (或者 Public，看你需求)
router.get("/public/:roomName", auth, async (req, res) => {
  try {
    const { roomName } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 查询逻辑：
    // 1. room 匹配
    // 2. toUser 必须为 null (确保不是发错到频道的私聊)
    const query = { 
      room: roomName, 
      toUser: null 
    };

    const messages = await Chat.find(query)
      .sort({ createdDate: -1 }) // 按时间倒序查（最新的在前）
      .skip(skip)
      .limit(limit);

    // 返回前反转数组，让前端按时间正序渲染（旧 -> 新）
    res.json(messages.reverse());
  } catch (err) {
    console.error("获取群聊记录失败:", err);
    res.status(500).json({ msg: "Server Error" });
  }
});

// @route   GET api/chat/private/:targetUserId
// @desc    获取“我”和“目标用户”之间的私聊记录
// @access  Private
router.get("/private/:targetUserId", auth, async (req, res) => {
  try {
    const targetUserId = req.params.targetUserId;
    const currentUserId = req.userId; 

    // 1. 安全校验
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(400).json({ msg: "无效的用户ID" });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2. 查询条件
    const query = {
      room: "private",
      $or: [
        { "user.id": currentUserId, toUser: targetUserId },
        { "user.id": targetUserId, toUser: currentUserId }
      ]
    };

    const messages = await Chat.find(query)
      .sort({ createdDate: -1 })
      .skip(skip)
      .limit(limit)
      // 3. 🔥 核心修复：字段名改为 displayName 和 photoURL
      .populate("toUser", "displayName photoURL") 
      .populate("user.id", "displayName photoURL"); // <--- 这里之前写错了，现已修正

    // 4. (可选) 数据清洗
    // 如果你的前端直接读取 msg.user.photoURL，而 populate 把 user.id 变成了对象
    // 你可能需要把最新的头像“提”出来覆盖快照，或者前端改读取路径
    const formattedMessages = messages.map(msg => {
        const msgObj = msg.toObject();
        
        // 如果关联查询到了最新的用户信息，用最新的覆盖旧的
        if (msgObj.user && msgObj.user.id && msgObj.user.id.displayName) {
            msgObj.user.displayName = msgObj.user.id.displayName;
            msgObj.user.photoURL = msgObj.user.id.photoURL;
        }
        
        // 同理处理 toUser (接收者信息)
        // toUser 本身就是 populate 出来的对象，不需要额外处理，前端直接 msg.toUser.photoURL 即可
        
        return msgObj;
    });

    res.json(formattedMessages.reverse());
  } catch (err) {
    console.error("获取私聊记录失败:", err);
    res.status(500).json({ msg: "Server Error" });
  }
});
  
  module.exports = router;