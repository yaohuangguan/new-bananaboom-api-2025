const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const FitnessSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  // --- 核心时间索引 ---
  date: { type: Date, required: true },
  dateStr: { type: String, required: true }, // YYYY-MM-DD

  // --- 1. 身体指标 (Body Stats) ---
  body: {
    weight: { type: Number }, // 体重 (kg)
    bodyFat: { type: Number }, // 体脂率 (%)
    chest: { type: Number },   // 胸围
    waist: { type: Number },   // 腰围
    hips: { type: Number }     // 臀围
  },

  // --- 2. 运动记录 (Workout) ---
  workout: {
    isDone: { type: Boolean, default: false }, // 是否健身
    duration: { type: Number, default: 0 },    // 时长 (分钟)
    caloriesBurned: { type: Number },          // 消耗热量 (kcal)
    types: [{ type: String }],                 // 运动类型标签，如 ["有氧", "胸肌", "瑜伽"]
    intensity: {                               // 强度主观感受
      type: String, 
      enum: ['low', 'medium', 'high', 'extreme'],
      default: 'medium'
    },
    note: { type: String, maxlength: 500 }     // 具体的训练笔记 (今天推了多少KG)
  },

  // --- 3. 饮食与营养 (Nutrition) ---
  nutrition: {
    totalCalories: { type: Number }, // 今日摄入总热量
    waterIntake: { type: Number },   // 喝水量 (ml)
    protein: { type: Number },       // 蛋白质 (g)
    carbs: { type: Number },         // 碳水 (g)
    fat: { type: Number },           // 脂肪 (g)
    dietNote: { type: String }       // 饮食备注 (比如: "今天吃了欺骗餐")
  },

  // --- 4. 状态与恢复 (Recovery) ---
  status: {
    mood: { 
      type: String, 
      enum: ['happy', 'neutral', 'sad', 'tired', 'energetic'],
      default: 'neutral' 
    },
    sleepHours: { type: Number }, // 昨晚睡眠时长
    energyLevel: { type: Number, min: 1, max: 10 }, // 活力指数 1-10
  },

  // --- 5. 媒体 (Media) ---
  photos: [{ type: String }] // 存放 Cloudinary 图片链接 (体态照)

}, { timestamps: true });

// 复合唯一索引
FitnessSchema.index({ user: 1, dateStr: 1 }, { unique: true });

module.exports = mongoose.model('fitness', FitnessSchema);