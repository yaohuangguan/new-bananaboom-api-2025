const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const PhotoSchema = new Schema({
  // 照片链接 (必填)
  url: {
    type: String,
    required: true
  },
  // 照片名称/备注 (选填，不填默认叫"未命名照片")
  name: {
    type: String,
    default: "未命名照片"
  },
  // 上传时间 (默认当前时间)
  createdDate: {
    type: Date,
    default: Date.now
  }
});

// 导出模型，集合名会自动变成 'photos'
module.exports = mongoose.model("photos", PhotoSchema);