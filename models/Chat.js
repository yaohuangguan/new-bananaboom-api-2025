const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ChatSchema = new Schema({
  // 发送消息的人
  user: {
    name: { type: String, required: true },
    avatar: { type: String }, // 可选：如果有头像url
    id: { type: Schema.Types.ObjectId, ref: "users" } // 关联用户表
  },

  // 接收消息的人 (私聊核心)
  // 如果是群聊，这里是 null；如果是私聊，这里存对方的 User ID
  toUser: { 
    type: Schema.Types.ObjectId, 
    ref: "users", 
    default: null 
  },

  // 消息内容
  content: { type: String, required: true },

  // 房间/频道
  // 默认是 "public" (大厅)，也可以是 "gaming", "coding" 等特定房间名
  // 如果是私聊，你可以约定一个规则(比如把两个人的ID拼起来)或者忽略此字段只看 toUser
  room: { type: String, default: "public" },

  // 发送时间
  createdDate: { type: Date, default: Date.now }
});

module.exports = mongoose.model("chat", ChatSchema);