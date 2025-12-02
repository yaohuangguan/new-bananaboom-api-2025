const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ChatSchema = new Schema({
  user: {
    name: { type: String, required: true },
    avatar: { type: String }, //如果有头像
    id: { type: Schema.Types.ObjectId, ref: "users" } // 关联用户表
  },
  content: { type: String, required: true },
  room: { type: String, default: "public" }, // 以后可以做多房间
  createdDate: { type: Date, default: Date.now }
});

module.exports = mongoose.model("chat", ChatSchema);