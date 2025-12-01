const mongoose = require("mongoose");

const ChatsSchema = mongoose.Schema({
  user: String,
  message: String
});

module.exports = mongoose.model("chats", ChatsSchema);
