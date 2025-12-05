const express = require("express");
const router = express.Router();
const Chat = require("../models/Chat"); // 引用你的 Chat 模型
const auth = require("../middleware/auth"); // 引用鉴权中间件
const mongoose = require('mongoose')


// ==========================================
// 🔥🔥🔥 核心修改：只给 Chat 路由加“防缓存”补丁
// ==========================================
router.use((req, res, next) => {
  // 告诉浏览器：这个接口的数据永远是最新的，绝对不要缓存！
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});


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
router.get("/private/:targetUserId", auth, async (req, res) => {
  try {
    const targetUserId = req.params.targetUserId;
    const currentUserId = req.userId; // 这是从 Token 解析出来的“我”的 ID

    console.log("--------------- 🔍 私聊接口调试 start ---------------");
    console.log("1. 前端传来的目标 ID (target):", targetUserId);
    console.log("2. 当前登录用户 ID (me):    ", currentUserId);

    // 1. 基础校验
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      console.log("❌ 目标 ID 格式无效");
      return res.status(400).json({ msg: "无效的用户ID" });
    }

    // 2. 强制转换 ID 类型 (关键修复点)
    // Mongoose 在复杂查询($or)中有时不会自动把 String 转成 ObjectId，手动转最稳
    const myId = new mongoose.Types.ObjectId(currentUserId);
    const targetId = new mongoose.Types.ObjectId(targetUserId);

    // 3. 构建查询条件
    const query = {
      room: "private",
      $or: [
        // 情况 A: 我发给他的 (我是 sender, 他是 receiver)
        { "user.id": myId, toUser: targetId },
        // 情况 B: 他发给我的 (他是 sender, 我是 receiver)
        { "user.id": targetId, toUser: myId }
      ]
    };

    console.log("3. MongoDB 查询条件:", JSON.stringify(query, null, 2));

    // 4. 执行查询
    const messages = await Chat.find(query)
      .sort({ createdDate: -1 })
      .populate("toUser", "displayName photoURL")
      .populate("user.id", "displayName photoURL");

    console.log(`4. 查询结果: 找到 ${messages.length} 条消息`);

    // 5. 如果没查到，尝试做一个“宽松查询”来辅助排查 (只查 room 和 toUser)
    if (messages.length === 0) {
        const looseCheck = await Chat.findOne({ room: "private", toUser: targetId });
        if (looseCheck) {
            console.log("⚠️ 警告: 数据库里确实有发给这个人的私聊，但'发送者'不是当前登录用户！");
            console.log("  -> 数据库里的发送者 user.id 是:", looseCheck.user.id);
            console.log("  -> 而你现在的 currentUserId 是:", currentUserId);
            console.log("  -> 结论: 你的 Token 是旧的，或者数据库被重置过，导致 ID 不匹配。");
        } else {
            console.log("⚠️ 警告: 数据库里连'发给这个targetId'的私聊都没有。可能存的时候 toUser 存错了？");
        }
    }

    console.log("--------------- 🔍 私聊接口调试 end ---------------");

    // 6. 数据清洗返回
    const formattedMessages = messages.map(msg => {
        const m = msg.toObject();
        // 确保 user 结构扁平化，防止前端读取报错
        if (m.user && m.user.id) {
             const senderInfo = m.user.id; // populate 之后的对象
             m.user.displayName = senderInfo.displayName;
             m.user.photoURL = senderInfo.photoURL;
             m.user.id = senderInfo._id; // 还原 ID
        }
        return m;
    });

    res.json(formattedMessages.reverse());

  } catch (err) {
    console.error("❌ 接口报错:", err);
    res.status(500).json({ msg: "Server Error" });
  }
});
  
  module.exports = router;