import { Schema, model } from 'mongoose';

const LogSchema = Schema({
  version: String,
  update_date: String,
  info: String
});

export default model('logs', LogSchema);
