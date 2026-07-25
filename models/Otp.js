import { Schema, model } from 'mongoose';

const OtpSchema = new Schema({
  identifier: {
    type: String,
    required: true,
    index: true
  },
  code: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300
  }
});

export default model('otps', OtpSchema);
