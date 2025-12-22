// utils/scheduler.js
import { schedule } from 'node-cron';
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import { NEW_NOTIFICATION } from '../socket/events.js';

export default (io) => {
  console.log('⏰ Scheduler Service Started (Cron Job Active)');

  // 每分钟扫描一次
  schedule('* * * * *', async () => {
    try {
      const now = new Date();

      // 1. 查找需要提醒的任务
      // 条件：remindAt 已到期 AND 还没通知过 AND 还没完成
      const tasksToRemind = await Todo.find({
        remindAt: { $exists: true, $lte: now },
        isNotified: false,
        status: { $ne: 'done' }
      }).populate('user', 'displayName role email');

      if (tasksToRemind.length > 0) {
        console.log(`⏰ [Scheduler] 触发提醒: ${tasksToRemind.length} 个任务`);
      }

      // 预先获取所有 Super Admin (家庭成员) 的 ID
      const superAdmins = await User.find({ role: 'super_admin' }).select('_id');
      const familyIds = superAdmins.map((u) => u._id.toString());

      // 2. 遍历推送
      for (const task of tasksToRemind) {
        if (!task.user) continue;

        const taskOwnerRole = task.user.role;
        const taskContent = task.todo;

        // 构造消息体
        const notificationPayload = {
          type: 'system_reminder',
          content: `🔔 提醒：${taskContent}`,
          taskId: task._id,
          timestamp: new Date(),
          fromUser: {
            displayName: '待办管家',
            id: 'system',
            photoURL: 'https://cdn-icons-png.flaticon.com/512/3602/3602145.png'
          }
        };

        // --- 分支推送逻辑 ---
        if (taskOwnerRole === 'super_admin') {
          // A. 家庭任务 -> 广播给所有家庭成员
          console.log(`👨‍👩‍👧 [Family Broadcast] Task: ${taskContent}`);

          familyIds.forEach((memberId) => {
            io.to(memberId).emit(NEW_NOTIFICATION, {
              ...notificationPayload,
              content: `🔔 家庭提醒：${taskContent} (来自 ${task.user.displayName})`
            });
          });
        } else {
          // B. 普通任务 -> 只发给本人
          const userId = task.user._id.toString();
          console.log(`👤 [Private Push] User: ${userId}`);
          io.to(userId).emit(NEW_NOTIFICATION, notificationPayload);
        }

        // 3. 标记为已通知
        task.isNotified = true;
        await task.save();
      }
    } catch (err) {
      console.error('❌ Scheduler Error:', err);
    }
  });
};
