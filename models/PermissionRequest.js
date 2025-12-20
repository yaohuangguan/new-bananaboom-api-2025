const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const PermissionRequestSchema = new Schema({
  // 申请人
  user: {
    type: Schema.Types.ObjectId,
    ref: "users",
    required: true
  },
  
  // 申请的权限 key (例如: 'fitness:read_all')
  permission: {
    type: String,
    required: true
  },

  // 申请理由 (例如: "我是教练，需要查看学员数据")
  reason: {
    type: String,
    default: ""
  },

  // 状态 flow
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },

  // 处理人 (Super Admin 的 ID)
  reviewedBy: {
    type: Schema.Types.ObjectId,
    ref: "users"
  },

  // 处理时间
  reviewedAt: {
    type: Date
  }

}, { timestamps: true });

module.exports = mongoose.model("permission_requests", PermissionRequestSchema);