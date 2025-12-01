const mongoose = require("mongoose");

const ResumeSchema = mongoose.Schema({
  title: {
    type: String
  },
  _title: {
    type: String
  },
  info: {
    type: String
  },
  _info: {
    type: String
  },
  degree: {
    type: String
  },
  url: {
    type: String
  }
});

module.exports = mongoose.model("resumes", ResumeSchema);
