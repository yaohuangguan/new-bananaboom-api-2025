import { Schema, model } from 'mongoose';

const AuditLogSchema = new Schema({
  // 操作人 (关联 User)
  operator: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  // 操作类型 (例如: "CREATE_POST", "DELETE_COMMENT", "LOGIN")
  action: {
    type: String,
    required: true
  },
  // 操作对象的描述 (例如: "文章: 如何学习React")
  target: {
    type: String
  },
  // 详细信息 (存 JSON 对象，比如修改前后的值，或者报错信息)
  details: {
    type: Object
  },
  // 操作人 IP
  ip: {
    type: String
  },
  // 发生时间
  createdDate: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24 * 30 // (可选) 设置30天后自动删除，防止日志爆炸
  }
});

export default model('audit_logs', AuditLogSchema);
