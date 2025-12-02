const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth"); // 必须加鉴权！
const Post = require("../models/Post");
const checkPrivate = require("../middleware/checkPrivate"); // 引入新中间件

router.get("/", auth, checkPrivate, async (req, res) => {
  try {
    // 1. 并行查询所有重要数据
    // 这里我暂时注释掉了 Log，如果你确认了模型名字，请把注释打开
    const [posts /*, logs*/] = await Promise.all([
      Post.find({}).sort({ createdDate: -1 }),
      // Log.find({}).sort({ date: -1 }) 
    ]);

    // 2. 组装成一个大对象
    const backupData = {
      meta: {
        version: "1.0",
        exportDate: new Date().toISOString(),
        user: req.user.name // 记录是谁导出的
      },
      data: {
        posts: posts,
        // logs: logs
      }
    };

    // 3. 设置响应头，告诉浏览器这是一个文件下载
    const filename = `bananaboom-backup-${new Date().toISOString().split('T')[0]}.json`;
    
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // 4. 发送数据
    // 使用 JSON.stringify 的第三个参数 2，可以让输出的 JSON 带缩进，方便阅读
    res.send(JSON.stringify(backupData, null, 2));

  } catch (error) {
    console.error("Backup error:", error);
    res.status(500).send("Server Error during backup");
  }
});

module.exports = router;