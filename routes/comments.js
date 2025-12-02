const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Comment = require("../models/Comment");
const User = require("../models/User"); // 🔥 新增引入
const auth = require("../middleware/auth");

// --- 辅助函数：手动填充用户信息 ---
// 这个函数负责把 ID 替换成用户对象，如果 ID 是无效的(旧数据)，就保留原样
async function populateCommentsManually(comments) {
  // 1. 收集所有涉及到的 User ID
  const userIds = new Set();

  const collectId = (id) => {
    // 只有当 id 是合法的 24位 ObjectId 时才收集
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      userIds.add(id);
    }
  };

  comments.forEach(c => {
    collectId(c.user);
    if (c.reply) {
      c.reply.forEach(r => {
        collectId(r.user);
        collectId(r.targetUser);
      });
    }
  });

  // 2. 批量去 User 表查询这些用户
  const users = await User.find({ _id: { $in: Array.from(userIds) } })
    .select("displayName photoURL vip"); // 只取需要的字段

  // 3. 建立 ID -> User 的映射字典 (方便快速查找)
  const userMap = {};
  users.forEach(u => {
    userMap[u._id.toString()] = u.toObject();
  });

  // 4. 组装数据 (并做数据清洗)
  const normalizedComments = comments.map(c => {
    const finalContent = c.content || c.comment || "";

    // 处理楼主
    let finalUser = null;
    if (userMap[c.user]) {
      // 如果是新数据（ID能查到用户）
      finalUser = userMap[c.user];
    } else {
      // 如果是旧数据（字符串 "Cennifer1103" 或 查不到ID）
      finalUser = {
        _id: c._userid || "legacy_id",
        // 如果 c.user 是字符串就用它，否则叫匿名用户
        displayName: typeof c.user === 'string' ? c.user : "匿名用户", 
        photoURL: c.photoURL || "https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png",
        vip: false
      };
    }

    // 处理回复
    const normalizedReplies = (c.reply || []).map(r => {
      let replyUser = userMap[r.user];
      if (!replyUser) {
        replyUser = {
          displayName: typeof r.user === 'string' ? r.user : "匿名用户",
          photoURL: r.photoURL || ""
        };
      }
      
      let targetUser = userMap[r.targetUser];
      // 如果找不到目标用户，但旧数据里可能也没存 targetUser，就忽略

      return { ...r, user: replyUser, targetUser };
    });

    return {
      ...c,
      content: finalContent,
      user: finalUser,
      reply: normalizedReplies
    };
  });

  return normalizedComments;
}

// ==========================================
// 1. 获取某篇文章的所有评论 (手动关联版)
// GET /api/comments/:postId
// ==========================================
router.get("/:postId", async (req, res) => {
  try {
    // 1. 先只取评论数据，不 populate，防止报错
    const comments = await Comment.find({
      $or: [ { post: req.params.postId }, { _postid: req.params.postId } ]
    })
    .sort({ date: -1 })
    .lean(); // 转为普通对象

    // 2. 手动关联并清洗
    const result = await populateCommentsManually(comments);
    
    res.json(result);
  } catch (error) {
    console.error("Get comments error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// 2. 获取单个评论 (手动关联版)
// GET /api/comments/reply/:commentId
// ==========================================
router.get("/reply/:commentId", async (req, res) => {
  try {
    let comment = null;
    try {
        comment = await Comment.findById(req.params.commentId).lean();
    } catch(e) {
        // ID 格式不对
    }

    if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
    }

    // 复用逻辑
    const result = await populateCommentsManually([comment]);
    res.json(result); 

  } catch (error) {
    console.error("Get single comment error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// 3. 发表评论 (保持不变，只是返回时也要用 populate)
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
    
    // 这里因为是新数据，ID 肯定是合法的，可以用 mongoose populate
    const populatedComment = await Comment.findById(savedComment._id)
      .populate("user", "displayName photoURL vip");

    res.json(populatedComment);
  } catch (error) {
    console.error("Post comment error:", error);
    res.status(500).json({ message: "Error creating comment" });
  }
});

// ==========================================
// 4. 回复评论 (保持不变)
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

    // 这里因为回复里可能有旧数据的 ID，也建议用手动方法返回，或者仅返回更新部分
    // 为了简单，我们这里还是用 populate，因为我们这次只是查这一条刚更新的评论
    // 如果这条评论里包含旧的 reply user 字符串，mongoose populate 会自动忽略它（返回 null），不会报错
    // 只要不是主 user 字段格式错误就行
    const updatedComment = await Comment.findById(req.params.commentId)
      .lean(); // 先取出来

    // 用手动方法清洗一遍，保证万无一失
    const result = await populateCommentsManually([updatedComment]);

    res.json(result);

  } catch (error) {
    console.error("Reply error:", error);
    res.status(500).json({ message: "Error posting reply" });
  }
});

module.exports = router;