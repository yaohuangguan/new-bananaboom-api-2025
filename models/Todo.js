const mongoose = require("mongoose");

const TodoSchema = mongoose.Schema({
  todo: String,
  complete_date: String,
  create_date: String,
  done: Boolean,
  timestamp:String
});

module.exports = mongoose.model("todos", TodoSchema);
