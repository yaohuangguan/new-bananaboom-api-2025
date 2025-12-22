import { Schema, model } from 'mongoose';

const PhotoSchema = new Schema({
  url: {
    type: String,
    required: true
  },
  name: {
    type: String,
    default: '未命名照片'
  },
  // 这个字段既代表上传时间，也可以作为拍摄时间
  // 我们允许前端传入这个值，如果不传，默认是当前时间
  createdDate: {
    type: Date,
    default: Date.now
  },
  // 🔥 新增：排序字段
  // 我们设置默认值为 0，后面会动态计算
  order: {
    type: Number,
    default: 0
  }
});

export default model('photos', PhotoSchema);
