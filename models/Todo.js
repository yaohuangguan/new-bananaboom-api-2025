import { Schema, model } from 'mongoose';

const TodoSchema = new Schema(
  {
    // 🔥 新增：关联用户 (必须知道任务是谁的)
    user: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      required: true
    },

    // --- 旧字段 ---
    todo: { type: String, required: true }, // 标题
    complete_date: String,
    create_date: String,
    done: Boolean,
    timestamp: String,

    // --- 新增字段 (Bucket List) ---
    description: { type: String, default: '' },
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done'],
      default: 'todo'
    },
    images: [{ type: String }],

    // 计划日期 (宽泛的日期，如 2025-12-25)
    targetDate: { type: Date },

    // 🔥🔥🔥 核心新增：提醒专用字段 🔥🔥🔥
    // 具体的提醒时间点 (如 2025-12-24 18:00:00)
    remindAt: { type: Date },

    // 是否已经通知过 (防止重复推送)
    isNotified: { type: Boolean, default: false },

    order: { type: Number, default: 0 },
    // 🔥 新增：循环规则 (Cron 格式)
    // 例如: "0 * * * *" (每小时), "0 9-21 * * *" (早9晚9每小时), "0 8 * * 1" (每周一早8点)
    recurrence: { type: String, default: null },

    // 🔥 新增：任务类型 (区分 愿望 vs 例行提醒)
    type: {
      type: String,
      enum: ['wish', 'routine'],
      default: 'wish'
    }
  },
  { timestamps: true }
);

export default model('todos', TodoSchema);
