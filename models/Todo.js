import { Schema, model } from 'mongoose';

const TodoSchema = new Schema(
  {
    // --- 基础字段 ---
    user: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    todo: { type: String, required: true }, // 任务标题 (例如: "喝水")
    description: { type: String, default: '' }, // 描述 (例如: "喝一杯温水")
    
    // --- 类型区分 ---
    // wish: 愿望清单 (默认，一次性，完成后进历史)
    // routine: 例行公事 (定时提醒，可循环，通常不关注"完成"状态，只关注"提醒")
    type: {
      type: String,
      enum: ['wish', 'routine'],
      default: 'wish'
    },

    // --- 状态与时间 ---
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done'],
      default: 'todo'
    },
    done: { type: Boolean, default: false },
    complete_date: String, // 只有 wish 类型才真正用到这个
    
    // --- 提醒核心字段 ---
    // 下一次触发提醒的时间点。系统只认这个字段来发通知。
    remindAt: { type: Date }, 

    // 是否已经通知过 (对于单次任务，通知后置为 true；对于循环任务，计算完下次时间后置为 false)
    isNotified: { type: Boolean, default: false },

    // --- 循环规则 ---
    // 1. Cron 表达式: "0 * * * *" (每小时)
    // 2. 简单间隔: "interval:10m" (10分钟后), "interval:2h" (2小时后) -> 方便前端做简单倒计时
    recurrence: { type: String, default: null },

    // --- 辅助字段 ---
    images: [{ type: String }],
    order: { type: Number, default: 0 },
    timestamp: String, // 兼容旧字段
    create_date: String,
    targetDate: { type: Date } // 愿望的目标日期
  },
  { timestamps: true }
);

export default model('todos', TodoSchema);