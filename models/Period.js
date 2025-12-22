import { Schema, model } from 'mongoose';
import { VALID_COLOR_CODES } from '../config/periodConstants.js';

const PeriodSchema = Schema(
  {
    // 🔥 新增：绑定所属用户
    user: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      required: true // 加上 required，保证以后数据都有主
    },
    // 记录是谁操作的 (用于审计日志，不再用于数据隔离)
    operator: {
      type: Schema.Types.ObjectId,
      ref: 'users'
    },

    startDate: {
      type: Date,
      required: true
    },
    endDate: {
      type: Date
    },
    duration: {
      type: Number,
      default: 5
    },
    cycleLength: {
      type: Number,
      default: 28
    },
    symptoms: [
      {
        type: String
      }
    ],
    flow: {
      type: String,
      enum: ['light', 'medium', 'heavy'],
      default: 'medium'
    },
    note: {
      type: String,
      default: ''
    },
    // 🔥 优化：存英文 Code
    color: {
      type: String,
      enum: VALID_COLOR_CODES,
      default: 'RED_DARK'
    }
  },
  {
    timestamps: true
  }
);

// 🔥 优化索引：通常是查“某个用户”的“最近记录”
PeriodSchema.index({
  user: 1,
  startDate: -1
});

export default model('period', PeriodSchema);
