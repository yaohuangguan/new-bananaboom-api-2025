const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SessionSchema = new Schema({
  key: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  value: { 
    type: String, 
    required: true 
  },
  // 🔥 核心功能：TTL 索引
  // 这会让文档在创建 30 天后自动从数据库删除，实现 Redis 的过期功能
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 2592000 // 单位秒 (30天 = 2592000秒)
  }
});

module.exports = mongoose.model("sessions", SessionSchema);