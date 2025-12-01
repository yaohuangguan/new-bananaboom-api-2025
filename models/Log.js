const mongoose = require("mongoose");

const LogSchema = mongoose.Schema({
  version: String,
  update_date: String,
  info: String
});

module.exports = mongoose.model("logs", LogSchema);
