const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ChatSchema = new Schema({
  // 发送消息的人
  user: {
    displayName: { type: String, required: true }, // 以前是 name
    photoURL: { type: String },                   // 以前是 avatar
    id: { type: Schema.Types.ObjectId, ref: "users" } 
  },

  // 接收消息的人 (私聊)
  toUser: { 
    type: Schema.Types.ObjectId, 
    ref: "users", 
    default: null 
  },

  content: { type: String, required: true },
  room: { type: String, default: "public" },
  createdDate: { type: Date, default: Date.now }
});

module.exports = mongoose.model("chat", ChatSchema);