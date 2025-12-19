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
    // 🔥 新增：身高快照 (cm)
    // 每次记录时，自动从 User 表拿过来存一份，或者是用户当天手动填的
    height: { type: Number }, 
    
    // 🔥 新增：BMI 指数
    // 自动计算存入：Weight(kg) / (Height(m) * Height(m))
    bmi: { type: Number },
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
    water: { type: Number, default: 0 }, // 喝了几杯水/ml (这个通常很有用且好记，建议保留)
    // 🔥🔥🔥 新增：当天的饮食模式快照
    // 方便以后分析：为啥这周体重没掉？哦，原来这周模式设成了 bulk
    goalSnapshot: { 
      type: String, 
      enum: ['cut', 'bulk', 'maintain'],
      default: 'maintain'
    } 
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
  photos: [{ type: String }], // 留着存照片
}, { timestamps: true });

// 复合唯一索引 (不变)
FitnessSchema.index({ user: 1, dateStr: 1 }, { unique: true });

// 🔥 核心逻辑：使用 Pre-save 钩子自动计算 BMI
// 这样你无论在哪里 save()，BMI 都会自动算好，不用手写计算逻辑
FitnessSchema.pre('save', function(next) {
  // 只有当体重和身高都有值的时候，才计算 BMI
  if (this.body && this.body.weight && this.body.height) {
    const heightInMeters = this.body.height / 100; // cm 转 m
    if (heightInMeters > 0) {
      // 保留1位小数 (例如 23.5)
      this.body.bmi = parseFloat((this.body.weight / (heightInMeters * heightInMeters)).toFixed(1));
    }
  }
  next();
});

module.exports = mongoose.model('fitness', FitnessSchema);