const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const FitnessSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  // --- 核心时间索引 (不变) ---
  date: { type: Date, required: true },
  dateStr: { type: String, required: true }, // YYYY-MM-DD

  // --- 1. 身体指标 (只留体重) ---
  body: {
    weight: { type: Number }, // 体重 (kg) - 最直观的指标
    // 去掉了胸围、腰围等复杂测量
  },

  // --- 2. 运动记录 (简化版) ---
  workout: {
    isDone: { type: Boolean, default: false }, // 今天练了吗？
    duration: { type: Number, default: 0 },    // 练了多少分钟？
    types: [{ type: String }],                 // 练了什么？(标签，如: ["跑步", "胸肌"])
    note: { type: String, maxlength: 500 }     // 训练笔记 (如: "今天状态不错，深蹲加重了")
    // 去掉了卡路里消耗、复杂的强度枚举
  },

  // --- 3. 饮食记录 (核心修改：只记吃了啥) ---
  diet: {
    content: { type: String, maxlength: 1000 }, // 直接写文字： "早饭面包牛奶，中午麻辣烫..."
    water: { type: Number, default: 0 }         // 喝了几杯水/ml (这个通常很有用且好记，建议保留)
    // 去掉了热量、蛋白质、碳水、脂肪计算
  },

  // --- 4. 状态 (保留，很有用) ---
  status: {
    mood: { 
      type: String, 
      enum: ['happy', 'neutral', 'bad'], // 简化心情选项
      default: 'neutral' 
    },
    sleepHours: { type: Number } // 睡了多久
  },

  // --- 5. 媒体 ---
  photos: [{ type: String }] // 留着存照片

}, { timestamps: true });

// 复合唯一索引 (不变)
FitnessSchema.index({ user: 1, dateStr: 1 }, { unique: true });

module.exports = mongoose.model('fitness', FitnessSchema);