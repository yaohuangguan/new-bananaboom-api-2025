const mongoose = require("mongoose");

const CommentSchema = mongoose.Schema({
  id: {
    required: true,
    type: mongoose.Schema.Types.ObjectId
  },
  _postid: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Post",
    required: true
  },
  _userid:{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  user: String,
  comment: String,
  date: {
    type: String,
    required: true
  },
  photoURL: String,
  reply: {
    type: Array,
    user: String,
    targetUser: String,
    photoURL: String,
    content: {
      required: true,
      type: String
    },
    id: {
      required: true,
      type: mongoose.Schema.Types.ObjectId,
      default: mongoose.Types.ObjectId
    },
    date: {
      type: String,
      required: true
    }
  }
});

module.exports = mongoose.model("comments", CommentSchema);
