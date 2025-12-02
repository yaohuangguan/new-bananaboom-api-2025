const express = require("express");
const router = express.Router();
const Comment = require("../models/Comment");
const auth = require("../middleware/auth");

// --- 辅助函数：数据清洗 (Adapter) ---
// 把新老数据格式统一，避免代码重复
const normalizeComment = (c) => {
  if (!c) return null;
  
  // 1. 统一内容
  const finalContent = c.content || c.comment || "";

  // 2. 统一用户
  let finalUser = c.user;
  if (!finalUser || typeof finalUser === 'string') {
    finalUser = {
      _id: c._userid || "legacy_id",
      displayName: typeof c.user === 'string' ? c.user : "匿名用户",
      photoURL: c.photoURL || "https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png",
      vip: false
    };
  }

  // 3. 统一回复列表
  const normalizedReplies = (c.reply || []).map(r => {
      let replyUser = r.user;
      if (!replyUser || typeof replyUser === 'string') {
          replyUser = {
              displayName: typeof r.user === 'string' ? r.user : "匿名用户",
              photoURL: r.photoURL || ""
          };
      }
      return { ...r, user: replyUser };
  });

  return {
    ...c,
    content: finalContent,
    user: finalUser,
    reply: normalizedReplies
  };
};

// ==========================================
// 1. 获取某篇文章的所有评论
// GET /api/comments/:postId
// ==========================================
router.get("/:postId", async (req, res) => {
  try {
    const comments = await Comment.find({
      $or: [ { post: req.params.postId }, { _postid: req.params.postId } ]
    })
    .sort({ date: -1 })
    .populate("user", "displayName photoURL vip")
    .populate("reply.user", "displayName photoURL")
    .populate("reply.targetUser", "displayName photoURL")
    .lean();

    // 批量清洗
    const result = comments.map(normalizeComment);
    res.json(result);
  } catch (error) {
    console.error("Get comments error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// 2. 【补回来的接口】获取单个评论 (及其回复)
// GET /api/comments/reply/:commentId
// ==========================================
router.get("/reply/:commentId", async (req, res) => {
  try {
    // 注意：这里用 findById 还是 find 看你旧逻辑，通常用 findById 查单个更准
    // 但为了兼容你旧代码 find({ id: ... })，这里我们兼容两种查法
    let comment = null;
    
    // 尝试按 _id 查 (新数据)
    try {
        comment = await Comment.findById(req.params.commentId)
            .populate("user", "displayName photoURL vip")
            .populate("reply.user", "displayName photoURL")
            .populate("reply.targetUser", "displayName photoURL")
            .lean();
    } catch(e) {
        // 如果 ID 格式不对 (旧数据可能存了非 ObjectId)，尝试按自定义 id 查
        // 但根据你的 Schema，ID 应该都是 ObjectId，所以通常这里不需要
    }

    if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
    }

    // 清洗数据并返回数组 (你旧接口返回的是数组)
    res.json([normalizeComment(comment)]); 

  } catch (error) {
    console.error("Get single comment error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// 3. 发表评论
// POST /api/comments/:postId
// ==========================================
router.post("/:postId", auth, async (req, res) => {
  const content = req.body.content || req.body.comment;
  if (!content) return res.status(400).json({ message: "Please say something" });

  try {
    const newComment = new Comment({
      user: req.user.id,
      post: req.params.postId,
      content: content,
      date: new Date()
    });

    const savedComment = await newComment.save();
    
    const populatedComment = await Comment.findById(savedComment._id)
      .populate("user", "displayName photoURL vip");

    res.json(populatedComment);
  } catch (error) {
    console.error("Post comment error:", error);
    res.status(500).json({ message: "Error creating comment" });
  }
});

// ==========================================
// 4. 回复评论
// POST /api/comments/reply/:commentId
// ==========================================
router.post("/reply/:commentId", auth, async (req, res) => {
  const content = req.body.reply || req.body.content;
  const targetUserId = req.body.targetUser;

  if (!content) return res.status(400).json({ message: "Please say something" });

  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    const newReply = {
      user: req.user.id,
      targetUser: targetUserId,
      content: content,
      date: new Date()
    };

    comment.reply.push(newReply);
    await comment.save();

    const updatedComment = await Comment.findById(req.params.commentId)
      .populate("user", "displayName photoURL vip")
      .populate("reply.user", "displayName photoURL vip")
      .populate("reply.targetUser", "displayName photoURL");

    // 为了兼容旧前端 getNewReply 逻辑，这里返回数组格式
    res.json([normalizeComment(updatedComment.toObject())]);

  } catch (error) {
    console.error("Reply error:", error);
    res.status(500).json({ message: "Error posting reply" });
  }
});

module.exports = router;