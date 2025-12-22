import { Schema, model } from 'mongoose';

// 回复 Schema
const ReplySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'users' },
  targetUser: { type: Schema.Types.ObjectId, ref: 'users' },
  content: { type: String, required: true },
  date: { type: Date, default: Date.now }
});

const CommentSchema = new Schema({
  // === 新字段 ===
  post: { type: Schema.Types.ObjectId, ref: 'posts' }, // 新关联
  user: { type: Schema.Types.ObjectId, ref: 'users' }, // 新关联
  content: { type: String }, // 新内容字段

  // === 旧字段兼容 (设为不必须) ===
  // 加上这些，Mongoose 才能读出旧数据库里的数据
  _postid: { type: Schema.Types.ObjectId },
  _userid: { type: Schema.Types.ObjectId },
  comment: { type: String }, // 旧内容字段
  photoURL: { type: String }, // 旧头像字段 (如果有)
  // 旧 user 字段可能是字符串名字，这会导致类型冲突。
  // 如果旧数据 user 存的是名字字符串，这里定义为 Mixed 或 String
  // 为了安全，我们暂不定义 user 为 String，靠代码逻辑处理，或者依靠 _userid 查找

  reply: [ReplySchema],
  date: { type: Date, default: Date.now }
});

export default model('comments', CommentSchema);
