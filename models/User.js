const mongoose = require("mongoose");

const UserSchema = mongoose.Schema({
  googleId: {
    type: String,
  },
  displayName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  date: {
    type: String,
    required: true
  },
  photoURL:{
    type:String,
    default:'https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png'
  },
  vip:{
    type:Boolean,
    default:false
  },
  // 🔥 新增：身高 (cm)
  // 这是用户的基准身高，设置一次通常不动了
  height: { 
    type: Number, 
    min: 50, 
    max: 300 
  },
    // 🔥🔥🔥 新增：健身目标/模式
  // cut: 减脂 (Fat Loss)
  // bulk: 增重/增肌 (Muscle Gain)
  // maintain: 保持 (Maintain)
  fitnessGoal: { 
    type: String, 
    enum: ['cut', 'bulk', 'maintain'], 
    default: 'maintain' 
  },
  // 🔥🔥🔥 新增：角色权限控制
  // user: 普通用户
  // admin: 管理员 (可以管理普通用户)
  // super_admin: 超级管理员 (就是 VIP，拥有最高权限)
  // bot: 机器人 (给 AI 预留，防止以后跟真人逻辑混淆)
  role: {
    type: String,
    enum: ['user', 'admin', 'super_admin', 'bot'],
    default: 'user', // 默认注册进来都是普通用户
    required: true   // 建议设为必填，配合 default 使用
  },
});

module.exports = mongoose.model("users", UserSchema);
