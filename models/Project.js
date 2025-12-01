const mongoose = require("mongoose");

const ProjectSchema = mongoose.Schema({
  name: String,
  _name: String,
  link: String,
  info: String,
  _info: String,
  image: String,
  width: Number,
  height: Number
});

module.exports = mongoose.model("projects", ProjectSchema);
