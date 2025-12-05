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



router.get("/private/:targetUserId", auth, async (req, res) => {
  try {
    const targetUserId = req.params.targetUserId;
    
    // 🔥🔥🔥 核心修复点在这里 🔥🔥🔥
    // 尝试从 req.user.id 获取 (这是最标准的 jwt 写法)
    // 如果没有，再试 req.userId (防止你中间件写法不一样)
    const currentUserId = (req.user && req.user.id) || req.userId;

    console.log("--------------- 🔍 修复后调试 ---------------");
    console.log("1. req.user 对象:", req.user); // 看看这个对象里到底有啥
    console.log("2. 最终获取到的 currentUserId:", currentUserId);

    if (!currentUserId) {
        console.log("❌ 严重错误: 无法获取当前用户 ID，Token 解析失败或中间件未正确挂载");
        return res.status(401).json({ msg: "用户未授权，无法获取 ID" });
    }

    // 1. 基础校验
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ msg: "无效的目标用户ID" });
    }

    // 2. 强制转换 ID 类型
    const myId = new mongoose.Types.ObjectId(currentUserId);
    const targetId = new mongoose.Types.ObjectId(targetUserId);

    // 3. 构建查询
    const query = {
      room: "private",
      $or: [
        { "user.id": myId, toUser: targetId },
        { "user.id": targetId, toUser: myId }
      ]
    };

    // 4. 执行查询
    const messages = await Chat.find(query)
      .sort({ createdDate: -1 })
      .populate("toUser", "displayName photoURL")
      .populate("user.id", "displayName photoURL");

    console.log(`✅ 查询成功，找到 ${messages.length} 条记录`);

    // 5. 数据清洗
    const formattedMessages = messages.map(msg => {
        const m = msg.toObject();
        if (m.user && m.user.id) {
             const senderInfo = m.user.id;
             m.user.displayName = senderInfo.displayName;
             m.user.photoURL = senderInfo.photoURL;
             m.user.id = senderInfo._id;
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