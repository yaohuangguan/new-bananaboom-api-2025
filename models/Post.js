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
  }, // 兼容旧数据

  // --- 内容 ---
  content: {
    type: String
  }, // 只保留这个核心内容字段
  url: {
    type: String
  }, // 原有的链接字段
  button: {
    type: String
  }, // 原有的按钮文字字段

  // --- 统计与状态 ---
  likes: {
    type: Number,
    default: 0
  },
  tags: {
    type: Array,
    default: []
  },
  isPrivate: {
    type: Boolean,
    default: false
  },

  createdDate: {
    type: Date,
    default: Date.now
  },
  updatedDate: {
    type: Date,
    default: Date.now
  },

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
});

// 索引优化
PostSchema.index({
  isPrivate: 1,
  createdDate: -1
});

export default model('post', PostSchema);