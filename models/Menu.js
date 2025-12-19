const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Menu Schema (私域大厨转盘 - 公共菜谱模型)
 * * 业务逻辑说明：
 * 1. 这是一个“公共池”，所有 VIP (家人) 共享这份菜单。
 * 2. `lastEaten` 是全局共享的。如果今天一个人点了确认，这道菜对所有人都会进入“冷却期”。
 * 3. `caloriesLevel` 用于前端实现“健康模式”开关。
 */
const MenuSchema = new Schema({
  // --- 审计字段 ---
  // 记录是谁创建了这道菜 (仅用于记录，不影响查看权限，所有 VIP 均可见)
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'users'
  },
  
  // --- 基础信息 ---
  // 菜名，全局唯一，防止重复添加
  name: { 
    type: String, 
    required: true, 
    unique: true 
  },
  
  // 分类：前端可用 Tabs 展示，如 "午餐", "晚餐", "夜宵"
  category: { 
    type: String, 
    default: '随机' 
  },
  
  // 标签数组：如 ["辣", "汤", "高蛋白"]。
  // 特殊逻辑：如果包含 "汤" 字样，确认时会自动给 Fitness 记录增加饮水量。
  tags: [{ type: String }], 
  
  // 图片 URL (用于转盘展示)
  image: { type: String },

  // --- 统计数据 (全局共享) ---
  // 被吃过的总次数
  timesEaten: { type: Number, default: 0 },
  
  // 上次吃的时间 (核心字段)
  // 用于计算“贤者模式” (Cooldown)。如果这个时间在 48小时内，贤者模式开启时会被隐藏。
  lastEaten: { type: Date },

  // --- 权重与状态 ---
  // 是否启用：false 时这道菜暂时被“雪藏”，不会出现在任何转盘里
  isActive: { type: Boolean, default: true },
  
  // 权重：1-10。权重越高，转盘里占的扇形面积越大 (前端可选实现)
  weight: { type: Number, default: 1 },
  
  // --- 健康配置 (用于开关 B) ---
  // low: 低热量/轻食 | medium: 正常 | high: 重油重辣/高热量
  // 当前端开启 "健康模式" (healthy=true) 时，后端会过滤掉 'high' 的菜品
  caloriesLevel: { 
    type: String, 
    enum: ['low', 'medium', 'high'], 
    default: 'medium' 
  }

}, { timestamps: true });

MenuSchema.index({ category: 1 });

module.exports = mongoose.model('menu', MenuSchema);