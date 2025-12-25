import {
  Schema,
  model
} from 'mongoose';

const PostSchema = Schema({
  // --- 基础信息 ---
  name: {
    type: String,
    required: true,
    trim: true
  },
  info: {
    type: String,
    required: true
  },
  author: {
    type: String,
    required: true
  },

  // --- 内容 ---
  content: {
    type: String
  },
  url: {
    type: String
  },
  button: {
    type: String
  },

  // --- 统计与状态 ---
  likes: {
    type: Number,
    default: 0,
    min: 0
  },
  tags: {
    type: Array,
    default: []
  },
  isPrivate: {
    type: Boolean,
    default: false
  },

  // ⚠️ 注意：这里删除了 createdDate 和 updatedDate 的手动定义
  // Mongoose 的 timestamps: true 会自动接管这两个字段

  // --- 交互 ---
  comments: {
    type: Array,
    default: []
  },

  // --- 关联 ---
  user: {
    type: Schema.Types.ObjectId,
    ref: 'users'
  }
}, {
  // 🔥 核心修改：使用标准时间戳
  // 这会自动在数据库生成 'createdAt' 和 'updatedAt' 两个字段
  timestamps: true
});

// 索引优化：注意改为 createdAt
PostSchema.index({
  isPrivate: 1,
  createdAt: -1
});

export default model('post', PostSchema);