const mongoose = require("mongoose");
const CommentSchema = require("./Comment");
const PostSchema = mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  info: {
    type: String,
    required: true
  },
  author: {
    type: String,
    required: true
  },
  createdDate: {
    type: String,
    required: true
  },
  likes: {
    type: Number
  },
  tags: {
    type: Array
  },
  content: {
    type: String
  },
  code: {
    type: String
  },
  codeGroup:{
    type:Array
  },
  code2: {
    type: String
  },
  url: {
    type: String
  },
  isPrivate:{
    type:Boolean
  },
  button:{
    type:String
  }
});

module.exports = mongoose.model("posts", PostSchema);
