const mongoose = require("mongoose");

const PeriodSchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  
  // 核心日期
  startDate: { type: Date, required: true }, // 姨妈来的第一天
  endDate: { type: Date },                   // 姨妈走的那一天
  
  // 统计数据
  duration: { type: Number, default: 5 },    // 经期持续天数 (默认5天)
  cycleLength: { type: Number, default: 28 },// 距离上一次的天数 (周期长度)

  // 身体感受
  symptoms: [{ type: String }], // ['痛经', '腰酸', '头痛']
  flow: { 
    type: String, 
    enum: ['light', 'medium', 'heavy'], 
    default: 'medium'
  },
  note: { type: String, default: "" }

}, { timestamps: true });

// 索引
PeriodSchema.index({ user: 1, startDate: -1 });

module.exports = mongoose.model("period", PeriodSchema);