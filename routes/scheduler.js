import { Router } from 'express';
const router = Router();
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import { NEW_NOTIFICATION } from '../socket/events.js';
import fetch from '../utils/http.js';
import cronParser from 'cron-parser'; // 🔥 务必 npm install cron-parser

// 从环境变量读取 Secret
const CRON_SECRET = process.env.CRON_SECRET || 'my-secret-key';

// @route   GET /api/cron/trigger
router.get('/trigger', async (req, res) => {
  // 1. 安全校验
  if (req.headers['x-scheduler-secret'] !== CRON_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ msg: 'Unauthorized' });
    }
  }

  try {
    const io = req.app.get('socketio');
    const now = new Date();

    // 2. 查库：找 [到期] 且 [未通知] 且 [未完成] 的任务
    // 🔥 关键点：populate 必须显式加上 +barkUrl，因为 Model 里它是 select: false
    const tasksToRemind = await Todo.find({
      remindAt: { $exists: true, $lte: now },
      isNotified: false,
      status: { $ne: 'done' }
    }).populate({
      path: 'user',
      select: 'displayName role email +barkUrl' // 👈 加上 +barkUrl
    });

    if (tasksToRemind.length === 0) {
      return res.json({ success: true, msg: 'No tasks to remind' });
    }

    console.log(`⏰ [Cron] 触发提醒: 处理 ${tasksToRemind.length} 个任务`);

    // 3. 预先获取 Super Admin 列表 (用于家庭广播)
    // 🔥 关键点：这里也要 select('+barkUrl')
    const superAdmins = await User.find({ role: 'super_admin' }).select('+barkUrl');

    for (const task of tasksToRemind) {
      // 容错：防止 user 被删了导致报错
      if (!task.user) continue;

      const title = `🔔 提醒：${task.todo}`;
      const content = task.description || '任务时间到了，快去完成吧！';

      const socketPayload = {
        type: 'system_reminder',
        content: `${title}`,
        taskId: task._id,
        timestamp: new Date(),
        fromUser: { displayName: '家庭管家', id: 'system' }
      };

      // --- A. 确定推送目标 ---
      let targetUsers = [];

      if (task.user.role === 'super_admin') {
        // 家庭任务 -> 推给全家
        targetUsers = superAdmins;
      } else {
        // 个人任务 -> 推给号主
        targetUsers = [task.user];
      }

      // --- B. 执行推送 (Socket + Bark) ---
      for (const target of targetUsers) {
        // 1. Socket 推送 (在线)
        if (io && target._id) {
          io.to(target._id.toString()).emit(NEW_NOTIFICATION, socketPayload);
        }

        // 2. Bark 推送 (离线/手机)
        if (target.barkUrl) {
          await sendBarkNotification(target.barkUrl, title, content);
        }
      }

      // --- C. 处理循环逻辑 vs 普通逻辑 ---
      try {
        if (task.recurrence) {
          // === 循环任务 (Routine) ===
          let nextRun;

          // 1. 判断循环类型
          if (task.recurrence.startsWith('interval:')) {
            // 👉 模式 A: 简单间隔 (例如 "interval:60m", "interval:2h")
            // 逻辑: 基于 [当前时间] + [间隔]
            const timeStr = task.recurrence.split(':')[1]; // 取出 "60m"
            const unit = timeStr.slice(-1); // 'm' or 'h'
            const value = parseInt(timeStr.slice(0, -1));
            
            // 计算毫秒数
            const ms = unit === 'h' ? value * 60 * 60 * 1000 : value * 60 * 1000;
            nextRun = new Date(now.getTime() + ms);

          } else {
            // 👉 模式 B: Cron 表达式 (例如 "0 9 * * *")
            // 逻辑: 使用 cron-parser 计算
            const interval = cronParser.parseExpression(task.recurrence, {
              currentDate: now
            });
            nextRun = interval.next().toDate();
          }

          console.log(`🔄 Routine [${task.todo}] 下次提醒: ${nextRun.toLocaleString()}`);

          // 2. 更新任务: 设置新时间 + 重置通知状态
          task.remindAt = nextRun;
          task.isNotified = false; // 🔥 关键：重置为 false 以便下次被扫到
          await task.save();

        } else {
          // === 普通愿望 (Wish) ===
          // 标记为已通知，不再打扰
          task.isNotified = true;
          await task.save();
        }
      } catch (err) {
        console.error(`❌ 处理任务 [${task.todo}] 失败:`, err.message);
        // 出错了也要标记已通知，防止死循环报错
        task.isNotified = true;
        await task.save();
      }
    }

    res.json({ success: true, processed: tasksToRemind.length });
  } catch (err) {
    console.error('❌ Scheduler Fatal Error:', err);
    res.status(500).send('Server Error');
  }
});

// 辅助函数：发送 Bark
async function sendBarkNotification(barkUrl, title, body) {
  try {
    if (!barkUrl) return;

    // 处理 URL 结尾的斜杠
    const baseUrl = barkUrl.endsWith('/') ? barkUrl.slice(0, -1) : barkUrl;
    const encodedTitle = encodeURIComponent(title);
    const encodedBody = encodeURIComponent(body);

    // 拼接 (指定图标)
    const finalUrl = `${baseUrl}/${encodedTitle}/${encodedBody}?icon=https://cdn-icons-png.flaticon.com/512/3602/3602145.png`;

    // Bark 默认是 GET 请求
    await fetch.get(finalUrl);
    console.log(`📱 Bark 推送成功 -> ${baseUrl.slice(-10)}`);
  } catch (e) {
    console.error(`❌ Bark 推送失败: ${e.message}`);
  }
}

export default router;
