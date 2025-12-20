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
  // 🔥 新增：额外权限列表 (特权)
  // 例如: ['fitness:read_all', 'logs:read']
  extraPermissions: { 
    type: [String], 
    default: [] 
  }
});

// =========================================================
// 🪝 Schema Hook: 自动同步 VIP 和 Role
// =========================================================
UserSchema.pre('save', function(next) {
  // 1. 如果是机器人(bot)，跳过同步逻辑 (防止机器人的特殊权限被覆盖)
  if (this.role === 'bot') {
    return next();
  }

  // 2. 场景 A: 角色(Role) 发生了变化
  // 优先级：Role > Vip (以 Role 为准)
  if (this.isModified('role')) {
    if (this.role === 'super_admin') {
      this.vip = true; // 升官必带 VIP
    } else {
      this.vip = false; // 降级自动取消 VIP (admin 也不算 vip, 只有 super_admin 算)
    }
  } 
  
  // 3. 场景 B: VIP 状态发生了变化 (且 Role 没变，防止冲突)
  // 这是一个快捷入口，比如支付成功后只把 vip 设为了 true
  else if (this.isModified('vip')) {
    if (this.vip === true) {
      this.role = 'super_admin'; // 充钱变强
    } else {
      // 如果取消了 VIP，且当前是 Super Admin，则降级为普通用户
      // 注意：如果本来是 admin，取消 vip 不应该变成 user，所以要判断一下
      if (this.role === 'super_admin') {
        this.role = 'user';
      }
    }
  }

  next();
});

module.exports = mongoose.model("users", UserSchema);
