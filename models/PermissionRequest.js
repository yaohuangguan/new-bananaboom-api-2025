const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const PermissionRequestSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: "users",
    required: true
  },
  
  // 🔥 新增：申请类型
  // 'permission': 申请 extraPermissions (看大盘、进私域)
  // 'role': 申请角色变更 (变成 admin)
  type: {
    type: String,
    enum: ['permission', 'role'], 
    default: 'permission'
  },

  // 目标值 (可能是权限Key 'fitness:read_all'，也可能是角色名 'admin')
  // 也就是之前的 permission 字段，我们复用它
  permission: {
    type: String,
    required: true
  },

  reason: { type: String, default: "" },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },

  reviewedBy: { type: Schema.Types.ObjectId, ref: "users" },
  reviewedAt: { type: Date }

}, { timestamps: true });

module.exports = mongoose.model("permission_requests", PermissionRequestSchema);