import { Router } from 'express';
const router = Router();
import { Types } from 'mongoose';
import Comment from '../models/Comment.js';
import User from '../models/User.js';
import auth from '../middleware/auth.js';
import logOperation from '../utils/audit.js'; // 引入工具

// --- 核心逻辑：手动关联并清洗数据 (Adapter) ---
async function populateCommentsManually(comments) {
  // A. 收集 ID
  const userIds = new Set();
  const collectId = (id) => {
    if (id && Types.ObjectId.isValid(id)) userIds.add(id.toString());
  };

  comments.forEach((c) => {
    collectId(c.user);
    if (c.reply) {
      c.reply.forEach((r) => collectId(r.user));
    }
  });

  // B. 查用户
  const users = await User.find({ _id: { $in: Array.from(userIds) } }).select('displayName photoURL role');

  const userMap = {};
  users.forEach((u) => (userMap[u._id.toString()] = u.toObject()));

  // C. 组装成前端要求的“特定结构”
  return comments.map((c) => {
    // 1. 解析用户
    let finalUser = null;
    let userIdString = '';

    if (c.user && userMap[c.user.toString()]) {
      finalUser = userMap[c.user.toString()];
      userIdString = finalUser._id.toString();
    } else {
      // 降级处理 (旧数据)
      userIdString = c._userid ? c._userid.toString() : 'legacy_id';
      finalUser = {
        _id: userIdString,
        displayName: typeof c.user === 'string' ? c.user : '匿名用户',
        photoURL: c.photoURL || 'https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png',
        vip: false
      };
    }

    // 2. 准备字段
    const contentText = c.content || c.comment || '';
    // 优先用关联用户的头像
    const finalPhotoURL = finalUser.photoURL || c.photoURL || '';

    // 3. 处理回复
    const normalizedReplies = (c.reply || []).map((r) => {
      let rUser = null;
      if (r.user && userMap[r.user.toString()]) {
        rUser = userMap[r.user.toString()];
      } else {
        rUser = {
          displayName: typeof r.user === 'string' ? r.user : '匿名用户',
          photoURL: r.photoURL || ''
        };
      }
      return {
        ...r,
        user: rUser,
        date: r.date // 🔥 这里不格式化，直接返回原始时间
      };
    });

    // 4. 构造目标格式
    return {
      _id: c._id,
      id: c._id.toString(),

      _postid: c.post || c._postid,
      _userid: userIdString,

      user: finalUser,
      photoURL: finalPhotoURL,

      comment: contentText,
      content: contentText,

      date: c.date, // 🔥 这里也不格式化，直接返回原始时间
      reply: normalizedReplies,

      __v: c.__v || 0
    };
  });
}

// ==========================================
// 接口 1: 获取列表
// ==========================================
router.get('/:postId', async (req, res) => {
  try {
    const comments = await Comment.find({
      $or: [{ post: req.params.postId }, { _postid: req.params.postId }]
    })
      .sort({ date: -1 })
      .lean();

    const result = await populateCommentsManually(comments);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ==========================================
// 接口 2: 获取单个回复列表
// ==========================================
router.get('/reply/:commentId', async (req, res) => {
  try {
    let comment = null;
    try {
      comment = await Comment.findById(req.params.commentId).lean();
    } catch (e) {
      console.log(e);
    }

    if (!comment) return res.status(404).json({ message: 'Not found' });

    const result = await populateCommentsManually([comment]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// ==========================================
// 接口 3: 发表评论
// ==========================================
router.post('/:postId', auth, async (req, res) => {
  const content = req.body.content || req.body.comment;
  if (!content) return res.status(400).json({ message: 'Say something' });

  try {
    const newComment = new Comment({
      user: req.user.id,
      post: req.params.postId,
      content: content,
      date: new Date()
    });
    await newComment.save();
    // 🔥🔥🔥 记录日志
    logOperation({
      operatorId: req.user.id,
      action: 'CREATE_COMMENT',
      target: `文章ID: ${req.params.postId}`,
      details: { content },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    const saved = await Comment.findById(newComment._id).lean();
    const result = await populateCommentsManually([saved]);

    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error' });
  }
});

// ==========================================
// 接口 4: 回复
// ==========================================
router.post('/reply/:commentId', auth, async (req, res) => {
  const content = req.body.reply || req.body.content;
  const targetUserId = req.body.targetUser;

  if (!content) return res.status(400).json({ message: 'Say something' });

  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Not found' });

    const newReply = {
      user: req.user.id,
      targetUser: targetUserId,
      content: content,
      date: new Date()
    };

    comment.reply.push(newReply);
    await comment.save();
    // 🔥🔥🔥 记录日志
    logOperation({
      operatorId: req.user.id,
      action: 'REPLY_COMMENT',
      target: `评论ID: ${req.params.commentId}`,
      details: { content },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    const updated = await Comment.findById(req.params.commentId).lean();
    const result = await populateCommentsManually([updated]);

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Error' });
  }
});

export default router;
