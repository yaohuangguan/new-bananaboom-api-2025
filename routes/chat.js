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
  
      // 1. 安全校验：防止 ID 格式错误导致报错
      if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
          return res.status(400).json({ msg: "无效的用户ID" });
      }
  
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;
  
      // 2. 核心修复：强制加上 room: "private"
      const query = {
        room: "private", // 🔥 这一行是关键！有了它，绝不会查出 public 消息
        $or: [
          { "user.id": currentUserId, toUser: targetUserId }, // 我发给他
          { "user.id": targetUserId, toUser: currentUserId }  // 他发给我
        ]
      };
  
      const messages = await Chat.find(query)
        .sort({ createdDate: -1 })
        .skip(skip)
        .limit(limit)
        // 3. 让 toUser 显示出具体信息（名字/头像），而不是光秃秃一个 ID
        // 如果你不需要头像，就把 "name avatar" 改成 "name"
        .populate("toUser", "name avatar") 
        .populate("user.id", "name avatar");
  
      res.json(messages.reverse());
    } catch (err) {
      console.error("获取私聊记录失败:", err);
      res.status(500).json({ msg: "Server Error" });
    }
  });
  
  module.exports = router;