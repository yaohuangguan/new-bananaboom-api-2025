import { Schema, model } from 'mongoose';

const ChatSchema = new Schema({
  // 发送者
  user: {
    displayName: { type: String, required: true },
    photoURL: { type: String },
    id: { type: Schema.Types.ObjectId, ref: 'users' }
  },

  // 接收者 (私聊用，AI对话时通常为null)
  toUser: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    default: null
  },

  content: { type: String, required: true },

  // 🔥 新增：关联到 Conversation 表的 UUID
  sessionId: { type: String, index: true },

  // 🔥 新增：图片存储 (Base64 字符串数组)
  images: [{ type: String }],

  room: { type: String, default: 'public' },
  createdDate: { type: Date, default: Date.now }
});

export default model('chat', ChatSchema);
