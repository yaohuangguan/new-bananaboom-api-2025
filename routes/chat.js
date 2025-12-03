const express = require("express");
const router = express.Router();
const Chat = require("../models/Chat"); // 引用你的 Chat 模型
const auth = require("../middleware/auth"); // 引用鉴权中间件

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

// ==========================================
// 2. 获取私聊历史记录 (Private)
// ==========================================
// @route   GET api/chat/private/:targetUserId
// @desc    获取“我”和“目标用户”之间的私聊记录
// @access  Private
router.get("/private/:targetUserId", auth, async (req, res) => {
  try {
    const targetUserId = req.params.targetUserId;
    const currentUserId = req.userId; // 假设 auth 中间件把 ID 放在了 req.userId

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 私聊查询核心逻辑：($or)
    // 情况A: 我发给他 (user.id = 我 AND toUser = 他)
    // 情况B: 他发给我 (user.id = 他 AND toUser = 我)
    const query = {
      $or: [
        { "user.id": currentUserId, toUser: targetUserId },
        { "user.id": targetUserId, toUser: currentUserId }
      ]
    };

    const messages = await Chat.find(query)
      .sort({ createdDate: -1 })
      .skip(skip)
      .limit(limit);

    res.json(messages.reverse());
  } catch (err) {
    console.error("获取私聊记录失败:", err);
    res.status(500).json({ msg: "Server Error" });
  }
});