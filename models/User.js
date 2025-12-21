const mongoose = require("mongoose");

const UserSchema = mongoose.Schema({
  googleId: {
    type: String,
    unique: true,
    sparse: true // 允许 googleId 不存在，但如果存在必须唯一
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
  // 🔥🔥🔥 新增：手机号 🔥🔥🔥
  phone: {
    type: String,
    unique: true, // 保证手机号不重复
    sparse: true, // 关键：允许这个字段不存在 (即允许很多人都没有手机号)
    trim: true    // 自动去掉前后的空格
  },
  date: {
    type: Date, // 建议用 Date 类型方便排序
    default: Date.now // 自动生成当前时间
  },
  photoURL:{
    type:String,
    default:'https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png'
  },
  vip:{
    type:Boolean,
    default:false
  },
  
  // --- 身体数据 ---
  height: { 
    type: Number, 
    min: 50, 
    max: 300 
  },
  fitnessGoal: { 
    type: String, 
    enum: ['cut', 'bulk', 'maintain'], 
    default: 'maintain' 
  },

  // --- 权限控制 ---
  role: {
    type: String,
    enum: ['user', 'admin', 'super_admin', 'bot'],
    default: 'user', 
    required: true 
  },
  // 额外权限 (特权)
  extraPermissions: { 
    type: [String], 
    default: [] 
  },
  // 🔥🔥🔥 新增：Bark 推送地址 (iOS) 🔥🔥🔥
  // 格式通常是: https://api.day.app/你的Key/
  barkUrl: {
    type: String,
    select: false // 🔒 关键安全设置：默认查询不返回此字段，保护隐私
  },
  // 🔥 新增：用户时区
  // 默认为上海时间，解决“写死”的问题，同时给了一个合理的初值
  timezone: {
    type: String,
    default: "Asia/Shanghai" 
  },
});

// =========================================================
// 🪝 Schema Hook: 自动同步 VIP 和 Role (Async 版)
// =========================================================
// 1. 注意：这里用了 async function()
// 2. 注意：参数里完全不要写 next
UserSchema.pre('save', async function() {
  // 1. 机器人跳过
  if (this.role === 'bot') {
    return; // 直接 return 即可，不需要 next()
  }

  // 2. 场景 A: 修改了 Role
  if (this.isModified('role')) {
    if (this.role === 'super_admin') {
      this.vip = true; 
    } else {
      // 只要不是 super_admin，就强制取消 vip
      this.vip = false; 
    }
  } 
  
  // 3. 场景 B: 修改了 VIP (且 Role 没变)
  else if (this.isModified('vip')) {
    if (this.vip === true) {
      this.role = 'super_admin'; 
    } else {
      if (this.role === 'super_admin') {
        this.role = 'user';
      }
    }
  }

  // 函数结束自动代表成功，不需要调用 next()
});

module.exports = mongoose.model("users", UserSchema);