import { Schema, model } from 'mongoose';

const RoleSchema = new Schema({
  // 角色名称，如 'admin', 'user' (作为唯一标识)
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  // 权限列表，如 ['FITNESS_USE', 'BLOG_INTERACT']
  permissions: [
    {
      type: String
    }
  ],

  // 描述 (可选)
  description: { type: String },

  updatedAt: { type: Date, default: Date.now }
});

export default model('roles', RoleSchema);
