import { Schema, model } from 'mongoose';

const PermissionSchema = new Schema({
  // 🔥 核心标识：代码里用的 Key，如 'FITNESS_USE'
  key: {
    type: String,
    required: true,
    unique: true,
    uppercase: true, // 强制大写
    trim: true
  },

  // 显示名称，如 '使用健身功能'
  name: { type: String, required: true },

  // 描述，如 '允许用户访问 /api/fitness 接口'
  description: { type: String },

  // 分类/模块，便于前端分组显示，如 'FITNESS', 'BLOG', 'ADMIN'
  category: { type: String, default: 'COMMON' },

  createdAt: { type: Date, default: Date.now }
});

export default model('permissions', PermissionSchema);
