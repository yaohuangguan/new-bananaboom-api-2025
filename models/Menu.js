import { Schema, model } from 'mongoose';

/**
 * Menu Schema - 私域大厨转盘 (公共菜单模型)
 * * 业务逻辑说明：
 * 1. 这是一个“公共池”，所有 VIP (家人) 共享这份菜单。
 * 2. 数据隔离：菜品数据是全局的，但“吃”这个动作产生的 Fitness 记录是私人的。
 * 3. 冷却逻辑：`lastEaten` 是全局共享的。今天吃过这道菜，明天全家人的转盘里这道菜都会进入冷却（如果开启贤者模式）。
 */
const MenuSchema = new Schema(
  {
    // --- 审计字段 ---
    // 记录是谁创建了这道菜 (仅用于记录贡献者，不作为权限控制，所有 VIP 均可见)
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'users'
    },

    // --- 基础信息 ---
    // 菜名，全局唯一，防止重复添加同一种菜
    name: {
      type: String,
      required: true,
      unique: true
    },

    // 分类：用于前端 Tabs 筛选，例如 "午餐", "晚餐", "夜宵"
    category: {
      type: String,
      default: '随机'
    },

    // 标签数组：如 ["辣", "汤", "高蛋白", "生酮"]。
    // 特殊逻辑：如果包含 "汤" 字样，后端在 confirm 接口会自动给 Fitness 记录增加 300ml 饮水量。
    tags: [{ type: String }],

    // 图片 URL (用于转盘扇形区域展示图片，提升体验)
    image: { type: String },

    // --- 统计数据 (全局共享) ---
    // 这道菜累计被选中的次数
    timesEaten: { type: Number, default: 0 },

    // 上次吃的时间 (核心字段)
    // 用途：用于“贤者模式” (Cooldown) 的计算。
    lastEaten: { type: Date },

    // --- 权重与状态 ---
    // 是否启用：false 时这道菜被“雪藏”，不会出现在任何列表和转盘中
    isActive: { type: Boolean, default: true },

    // 权重：1-10 (默认为 1)。
    // 用途：在 /draw 接口的算法中，权重越高，被随机抽中的概率越大。
    weight: { type: Number, default: 1 },

    // --- 健康配置 (用于前端开关：健康模式) ---
    // low: 低热量/轻食 | medium: 正常 | high: 重油重辣/高热量
    // 逻辑：当前端开启 "健康模式" (healthy=true) 时，/draw 接口会过滤掉 'high' 的菜品
    caloriesLevel: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    }
  },
  { timestamps: true }
);

// 索引优化
MenuSchema.index({ category: 1 });
MenuSchema.index({ isActive: 1 });

export default model('menu', MenuSchema);
