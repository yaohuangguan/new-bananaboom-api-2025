const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TodoSchema = new Schema({
  // --- 旧字段 (保持不变，确保老数据不丢) ---
  todo: { 
    type: String, 
    required: true // 这就是现在的“标题”
  },
  complete_date: String, // 旧的完成时间字符串
  create_date: String,   // 旧的创建时间字符串
  done: Boolean,         // 旧的状态 (true/false)
  timestamp: String,     // 旧的时间戳

  // --- 新增字段 (Bucket List 升级包) ---
  description: { 
    type: String, 
    default: "" // 详细攻略/描述
  },
  
  // 状态升级：兼容旧的 done=true
  // 新数据用这个字段控制：'todo'(想做), 'in_progress'(进行中), 'done'(已完成)
  status: {
    type: String,
    enum: ['todo', 'in_progress', 'done'],
    default: 'todo'
  },

  // 配图打卡 (支持多张图片 URL)
  images: [{ 
    type: String 
  }],

  // 计划日期 (比如：计划2025年去)
  targetDate: { type: Date },
  
  // 排序权重 (置顶用)
  order: { type: Number, default: 0 }

}, { timestamps: true }); // 开启自动时间戳 (createdAt, updatedAt)

module.exports = mongoose.model("todos", TodoSchema);