import { Schema, model } from 'mongoose';

const TodoSchema = new Schema(
  {
    // ... 原有字段 (user, notifyUsers, todo, description, type, recurrence, remindAt, status ...)
    user: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    notifyUsers: [{ type: Schema.Types.ObjectId, ref: 'users' }],
    todo: { type: String, required: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['wish', 'routine'], default: 'wish' },
    recurrence: { type: String, default: null },
    remindAt: { type: Date },
    isNotified: { type: Boolean, default: false },
    status: { type: String, default: 'todo' },
    done: { type: Boolean, default: false },
    images: [{ type: String }],
    order: { type: Number, default: 0 },
    targetDate: { type: Date },

    // 🔥🔥🔥 新增：Bark 高级配置 🔥🔥🔥
    bark: {
      // 1. 铃声 (例如: 'minuet', 'birdsong', 'alarm', 'glass')
      // 默认用 'minuet' (类似于系统提示音)
      sound: { type: String, default: 'minuet' },

      // 2. 中断级别
      // 'active': 默认，点亮屏幕
      // 'timeSensitive': 时效性通知 (可突破勿扰模式，适合紧急任务)
      // 'passive': 被动通知 (不亮屏，默默加到列表里，适合非紧急的记录)
      level: {
        type: String,
        enum: ['active', 'timeSensitive', 'passive'],
        default: 'active'
      },

      // 3. 图标 (如果不填，Scheduler 会用默认的闹钟图标)
      // 可以是 URL
      icon: { type: String, default: '' },

      // 4. 跳转 URL (点击通知后跳转哪里，可选)
      url: { type: String, default: '' },
      image: { type: String, default: '' },
    }
  },
  { timestamps: true }
);

export default model('todos', TodoSchema);
