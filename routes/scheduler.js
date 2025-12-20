const express = require("express");
const router = express.Router();
const Todo = require("../models/Todo");
const User = require("../models/User");
const { NEW_NOTIFICATION } = require("../socket/events");
const axios = require("axios");

// 从环境变量读取 Secret，防止外部恶意触发
const CRON_SECRET = process.env.CRON_SECRET || "bananaboom";

// @route   GET /api/cron/trigger
// @desc    由 Cloud Scheduler 每分钟触发一次
router.get("/trigger", async (req, res) => {
  // 1. 安全校验
  // Google Cloud Scheduler 会自动带上这个 header，或者你手动 curl 时带上
  if (req.headers["x-scheduler-secret"] !== CRON_SECRET) {
    console.warn("⚠️ 非法触发 Scheduler 尝试");
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
    const io = req.app.get("socketio");
    const now = new Date();

    // 2. 查库：找 [到期] 且 [未通知] 且 [未完成] 的任务
    const tasksToRemind = await Todo.find({
      remindAt: { $exists: true, $lte: now },
      isNotified: false,
      status: { $ne: 'done' }
    }).populate({
        path: 'user',
        select: 'displayName role email barkUrl' // 👈 这里要把所有需要的字段都列出来，加上 barkUrl
      });

    // 如果没任务，直接返回，节省计算资源
    if (tasksToRemind.length === 0) {
      return res.json({ success: true, msg: "No tasks to remind" });
    }

    console.log(`⏰ [Cron] 触发提醒: 处理 ${tasksToRemind.length} 个任务`);

    // 3. 预先获取 Super Admin 列表 (用于家庭广播)
    // 这里我们需要完整的 User 对象（含 barkUrl），不仅仅是 ID
    const superAdmins = await User.find({ role: 'super_admin' }).select('+barkUrl');

    for (const task of tasksToRemind) {
      if (!task.user) continue;

      const title = `🔔 提醒：${task.todo}`;
      const content = task.description || "记得按时完成哦！";
      
      // 准备 Socket 消息体
      const socketPayload = {
        type: "system_reminder",
        content: `${title}`,
        taskId: task._id,
        timestamp: new Date(),
        fromUser: { displayName: "家庭管家", id: "system" }
      };

      // --- 确定推送目标用户 (Target Users) ---
      let targetUsers = [];

      if (task.user.role === 'super_admin') {
        // 场景 A: 家庭任务 -> 推送给所有 Super Admin (你 + 老婆)
        targetUsers = superAdmins;
      } else {
        // 场景 B: 个人任务 -> 只推送给号主
        targetUsers = [task.user];
      }

      // --- 执行推送 (Socket + Bark) ---
      for (const target of targetUsers) {
        // 1. Socket 推送 (如果用户网页在线)
        // 注意：target.id 是 Mongoose 的虚拟 getter，可以直接用
        io.to(target.id).emit(NEW_NOTIFICATION, socketPayload);

        // 2. Bark 手机推送 (如果用户配置了 Bark URL)
        // 注意：User Model 里 barkUrl 默认 select: false，如果你改了 Model 可以直接用
        // 如果没改 Model，上面的 User.find 需要加上 .select('+barkUrl')
        if (target.barkUrl) {
           await sendBarkNotification(target.barkUrl, title, content);
        }
      }

      // 4. 标记为已通知
      task.isNotified = true;
      await task.save();
    }

    res.json({ success: true, processed: tasksToRemind.length });

  } catch (err) {
    console.error("❌ Scheduler Error:", err);
    res.status(500).send("Server Error");
  }
});

// 辅助函数：发送 Bark
async function sendBarkNotification(barkUrl, title, body) {
  try {
    // 自动处理 URL 结尾是否有 / 的问题
    const baseUrl = barkUrl.endsWith('/') ? barkUrl.slice(0, -1) : barkUrl;
    const encodedTitle = encodeURIComponent(title);
    const encodedBody = encodeURIComponent(body);
    
    // 拼接 Bark URL
    const finalUrl = `${baseUrl}/${encodedTitle}/${encodedBody}?icon=https://cdn-icons-png.flaticon.com/512/3602/3602145.png`;
    
    await axios.get(finalUrl);
    console.log(`📱 Bark 推送成功`);
  } catch (e) {
    console.error(`❌ Bark 推送失败: ${e.message}`);
  }
}

module.exports = router;