const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

// 引入所有数据模型
const User = require("../models/User");
const Post = require("../models/Post");
const Comment = require("../models/Comment");
const Todo = require("../models/Todo");
const Chat = require("../models/Chat");
const Photo = require("../models/Photo");
const Fitness = require("../models/Fitness");
const AuditLog = require("../models/AuditLog");




// @route   GET /api/backup
// @desc    导出数据库备份 (支持 ?type=users 单独导出)
// @access  Private & VIP Only
router.get("/", auth, checkPrivate, async (req, res) => {
  const { type } = req.query; // 获取查询参数，例如: ?type=photos

  try {
    let data = {};
    let filenamePrefix = "full";

    // 定义所有查询任务
    // 使用 Promise.all 并行查询，速度最快
    const fetchAll = async () => {
      const [users, posts, comments, todos, chats, photos, fitness, auditLog] = await Promise.all([
        User.find({}).select("-password"), // 为了安全，不导出密码哈希
        Post.find({}).sort({ createdDate: -1 }),
        Comment.find({}).sort({ date: -1 }),
        Todo.find({}).sort({ timestamp: -1 }), // Todo 用的是 timestamp
        Chat.find({}).sort({ createdDate: -1 }),
        Photo.find({}).sort({ createdDate: -1 }),
        Fitness.find({}).sort({ createdDate: -1 }),
        AuditLog.find({}).sort({ createdDate: -1 }),
      ]);
      return { users, posts, comments, todos, chats, photos, fitness, auditLog };
    };

    // 根据 type 参数决定导出什么
    if (type) {
      filenamePrefix = type; // 文件名变成 bananaboom-photos-xxx.json
      switch (type) {
        case "users":
          data.users = await User.find({}).select("-password");
          break;
        case "posts":
          data.posts = await Post.find({}).sort({ createdDate: -1 });
          break;
        case "comments":
          data.comments = await Comment.find({}).sort({ date: -1 });
          break;
        case "todos":
          data.todos = await Todo.find({}).sort({ timestamp: -1 });
          break;
        case "chats":
          data.chats = await Chat.find({}).sort({ createdDate: -1 });
          break;
        case "photos":
          data.photos = await Photo.find({}).sort({ createdDate: -1 });
          break;
        case "fitness":
          data.fitness = await Fitness.find({}).sort({ createdDate: -1 });
          break;
        case "audit":
          data.audit = await AuditLog.find({}).sort({ createdDate: -1 });
          break;
        default:
          // 如果 type 写错了，默认导出全部
          data = await fetchAll();
          filenamePrefix = "full";
      }
    } else {
      // 默认情况：导出全部
      data = await fetchAll();
    }

    // 组装最终 JSON
    const backupJSON = {
      meta: {
        version: "2.0",
        exportDate: new Date().toISOString(),
        exporter: req.user.displayName,
        type: type || "full_backup"
      },
      data: data
    };

    // 设置下载响应头
    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `bananaboom-${filenamePrefix}-${dateStr}.json`;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // 发送美化后的 JSON (缩进2空格)
    res.send(JSON.stringify(backupJSON, null, 2));

  } catch (error) {
    console.error("Backup error:", error);
    res.status(500).json({ message: "Server Error during backup" });
  }
});

module.exports = router;