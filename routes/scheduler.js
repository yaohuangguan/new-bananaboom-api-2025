import { Router } from 'express';
const router = Router();
import Todo from '../models/Todo.js';
import AuditLog from '../models/AuditLog.js'; // 引入审计日志
import { NEW_NOTIFICATION } from '../socket/events.js';
import fetch from '../utils/http.js'; // 你的 fetch/axios 封装
import cronParser from 'cron-parser'; // 🔥 必须 npm install cron-parser

const CRON_SECRET = process.env.CRON_SECRET || 'my-secret-key';

// =====================================================================
// 🛠 工具函数：计算下一次时间 (带时区感知)
// =====================================================================
function calculateNextRun(recurrence, baseTime, userTimezone = 'Asia/Shanghai') {
  if (!recurrence) return null;
  try {
    // 1. 简单间隔 (interval:30m) - 绝对时间，不涉及时区
    if (recurrence.startsWith('interval:')) {
      const timeStr = recurrence.split(':')[1];
      const unit = timeStr.slice(-1);
      const value = parseInt(timeStr.slice(0, -1));
      const msMap = { m: 60000, h: 3600000, d: 86400000 };
      return new Date(baseTime.getTime() + value * (msMap[unit] || 0));
    }
    // 2. Cron 表达式 - 依赖用户时区
    const interval = cronParser.parseExpression(recurrence, {
      currentDate: baseTime,
      tz: userTimezone // 🔥 核心：根据用户所在时区计算
    });
    return interval.next().toDate();
  } catch (err) {
    console.error(`[TimeCalc] Error: ${err.message}`);
    return null;
  }
}

// =====================================================================
// 🚀 触发接口 (Cloud Scheduler 调用)
// =====================================================================
router.get('/trigger', async (req, res) => {
  // 1. 安全校验
  if (req.headers['x-scheduler-secret'] !== CRON_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ msg: 'Unauthorized' });
    }
  }

  try {
    const io = req.app.get('socketio');
    const now = new Date(); // 服务器 UTC 时间

    // 2. 查库：找 [到期] 且 [未通知] 且 [未完成] 的任务
    const tasksToRemind = await Todo.find({
      remindAt: { $exists: true, $lte: now },
      isNotified: false,
      status: { $ne: 'done' }
    })
    // 🔥 A. 填充任务创建者 (用于获取 timezone 和 记录日志operator)
    .populate({
      path: 'user',
      select: 'displayName timezone photoURL email' 
    })
    // 🔥 B. 填充通知对象 (用于发通知 + 存日志快照)
    .populate({
      path: 'notifyUsers',
      select: 'displayName email photoURL +barkUrl' // 🔒 必须显式 +barkUrl
    });

    if (tasksToRemind.length === 0) {
      return res.json({ success: true, msg: 'No tasks to remind' });
    }

    console.log(`⏰ [Cron] 触发 ${tasksToRemind.length} 个任务`);

    for (const task of tasksToRemind) {
      // 容错: 防止 user 被删除
      if (!task.user) continue;

      // 准备文案
      const title = `🔔 ${task.todo}`;
      const body = task.description || '时间到了，该执行任务了！';

      // 确定目标
      let targets = [];
      if (task.notifyUsers && task.notifyUsers.length > 0) {
        targets = task.notifyUsers;
      } else {
        console.warn(`⚠️ Task [${task.todo}] 没有 notifyUsers，跳过推送`);
      }

      // Socket Payload
      const socketPayload = {
        type: 'system_reminder',
        content: `${title}: ${body}`,
        taskId: task._id,
        timestamp: new Date(),
        fromUser: { displayName: '管家', id: 'system' }
      };

      // 3. 执行推送 (遍历 targets)
      for (const target of targets) {
        // A. Socket 推送
        if (io && target._id) {
          io.to(target._id.toString()).emit(NEW_NOTIFICATION, socketPayload);
        }
        // B. Bark 推送 (传入 task.bark 高级配置)
        if (target.barkUrl) {
          await sendBarkNotification(target.barkUrl, title, body, task.bark);
        }
      }

      // 4. 更新任务状态 & 记录日志
      let nextRun = null;
      try {
        // --- 循环逻辑 ---
        if (task.recurrence) {
          // 获取用户时区 (默认上海)
          const userTZ = task.user.timezone || 'Asia/Shanghai';
          // 计算下一次
          nextRun = calculateNextRun(task.recurrence, now, userTZ);
          
          if (nextRun) {
            console.log(`🔄 Routine [${task.todo}] 下次: ${nextRun.toLocaleString('zh-CN', { timeZone: userTZ })}`);
            task.remindAt = nextRun;
            task.isNotified = false; // 重置，等待下次
          } else {
            task.isNotified = true; // 规则错误，标记已读防止死循环
          }
        } else {
          // 普通愿望：标记已通知
          task.isNotified = true;
        }
        await task.save();

        // --- 🔥 写入审计日志 (Audit Log) ---
        // 构建"被通知人"的快照 (Snapshot)
        const notifiedUsersSnapshot = targets.map(u => ({
          _id: u._id,
          displayName: u.displayName,
          photoURL: u.photoURL || '',
          email: u.email
        }));

        await AuditLog.create({
          operator: task.user._id, // 记在创建者名下
          action: 'SYSTEM_REMINDER',
          target: task.todo,
          details: {
            task_id: task._id,
            recurrence: task.recurrence,
            // 存入快照，前端直接渲染头像
            notified_users: notifiedUsersSnapshot,
            next_run: nextRun
          },
          ip: '127.0.0.1'
        });

      } catch (err) {
        console.error(`❌ 更新任务/日志失败: ${err.message}`);
        task.isNotified = true; // 容错兜底
        await task.save();
      }
    }

    res.json({ success: true, processed: tasksToRemind.length });
  } catch (err) {
    console.error('❌ Scheduler Fatal Error:', err);
    res.status(500).send('Server Error');
  }
});

// =====================================================================
// 📨 辅助函数：Bark 推送 (增强版 - 支持 Sound/Level/Icon)
// =====================================================================
async function sendBarkNotification(barkUrl, title, body, options = {}) {
  try {
    if (!barkUrl) return;
    
    // 1. 处理基础 URL
    const baseUrl = barkUrl.endsWith('/') ? barkUrl.slice(0, -1) : barkUrl;
    
    // 2. 准备 URL 参数
    const params = new URLSearchParams({
      // 图标: 如果 task 没配，用默认闹钟图标
      icon: options.icon || 'https://cdn-icons-png.flaticon.com/512/3602/3602145.png',
      // 铃声: 默认 minuet
      sound: options.sound || 'minuet',
      // 中断级别: 默认 active
      level: options.level || 'active',
      // 分组
      group: 'Todo'
    });

    // 如果有点击跳转
    if (options.url) {
      params.append('url', options.url);
    }

     // 如果有图片
     if (options.image) {
      params.append('image', options.image);
    }

    // 3. 拼接 & 发送
    // 格式: base/title/body?params
    const finalUrl = `${baseUrl}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params.toString()}`;
    
    await fetch.get(finalUrl);
    // console.log(`📱 Bark Params: ${params.toString()}`);
  } catch (e) {
    console.error(`❌ Bark Failed: ${e.message}`);
  }
}

export default router;