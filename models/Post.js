const mongoose = require("mongoose");

const PostSchema = mongoose.Schema({
  // ... 原有的字段保持不变 (name, info, author 等) ...
  name: { type: String, required: true },
  info: { type: String, required: true },
  author: { type: String, required: true }, // 旧的作者名字字段，保留用于兼容
  createdDate: { type: String, required: true },
  likes: { type: Number, default: 0 },
  tags: { type: Array },
  content: { type: String },
  code: { type: String },
  codeGroup: { type: Array },
  code2: { type: String },
  url: { type: String },
  isPrivate: { type: Boolean, default: false },
  button: { type: String },
  comments: { type: Array, default: [] }, // 之前加的

  // 🔥🔥🔥 新增：关联用户字段 🔥🔥🔥
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "users" // 这里的名字必须和你 User.js 里导出时的名字一致 ('users')
  }
});

module.exports = mongoose.model("posts", PostSchema);