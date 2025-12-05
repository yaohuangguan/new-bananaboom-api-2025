const mongoose = require("mongoose");

const PeriodSchema = mongoose.Schema({
  // 记录是谁操作的 (用于审计日志，不再用于数据隔离)
  operator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users'
  },
  
  startDate: { type: Date, required: true },
  endDate: { type: Date },
  duration: { type: Number, default: 5 },
  cycleLength: { type: Number, default: 28 },
  symptoms: [{ type: String }],
  flow: { 
    type: String, 
    enum: ['light', 'medium', 'heavy'], 
    default: 'medium'
  },
  note: { type: String, default: "" }
}, { timestamps: true });

// 索引改了：不再需要按 user 索引，直接按 startDate 排序
PeriodSchema.index({ startDate: -1 });

module.exports = mongoose.model("period", PeriodSchema);