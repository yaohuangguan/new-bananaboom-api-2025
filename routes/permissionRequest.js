const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const checkPermission = require("../middleware/checkPermission");
const K = require("../config/constants");

// 引入模型
const PermissionRequest = require("../models/PermissionRequest");
const User = require("../models/User");

// =================================================================
// 1. 提交申请 (任何登录用户)
// =================================================================
// @route   POST /api/permission-requests
// @body    { permission: 'fitness:read_all', reason: '...' }
router.post("/", auth, async (req, res) => {
  const { permission, reason } = req.body;

  // 1. 校验权限 Key 是否合法 (防止瞎填)
  const validKeys = Object.values(K);
  if (!validKeys.includes(permission)) {
    return res.status(400).json({ msg: "无效的权限 Key" });
  }

  try {
    const user = await User.findById(req.user.id);

    // 2. 检查用户是否已经拥有该权限
    // 注意：这里简单检查 extraPermissions，如果他在 role 里已有，也可以申请被拒
    if (user.extraPermissions.includes(permission)) {
      return res.status(400).json({ msg: "你已经拥有该权限，无需申请" });
    }

    // 3. 检查是否已经有待审批的同类申请 (防止狂点)
    const existingReq = await PermissionRequest.findOne({
      user: req.user.id,
      permission: permission,
      status: 'pending'
    });

    if (existingReq) {
      return res.status(400).json({ msg: "申请审核中，请耐心等待" });
    }

    // 4. 创建申请单
    const newRequest = new PermissionRequest({
      user: req.user.id,
      permission,
      reason
    });

    await newRequest.save();

    res.json({ success: true, msg: "申请已提交，请联系超级管理员审批" });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// =================================================================
// 2. 获取申请列表 (Super Admin Only)
// =================================================================
// @route   GET /api/permission-requests?status=pending
router.get("/", auth, checkPermission('*'), async (req, res) => {
  try {
    const { status } = req.query;
    let query = {};

    // 默认只看待审批的，也可以传 'approved' 看历史
    if (status) {
      query.status = status;
    }

    const requests = await PermissionRequest.find(query)
      .populate("user", "displayName email photoURL role") // 显示申请人信息
      .sort({ createdAt: -1 }); // 最新的在前面

    res.json(requests);

  } catch (err) {
    res.status(500).send("Server Error");
  }
});

// =================================================================
// 3. 审批通过 (Super Admin Only) - 🔥 核心: 同意即授权
// =================================================================
// @route   PUT /api/permission-requests/:id/approve
router.put("/:id/approve", auth, checkPermission('*'), async (req, res) => {
  try {
    // 1. 找到申请单
    const request = await PermissionRequest.findById(req.params.id);
    
    if (!request) return res.status(404).json({ msg: "申请单不存在" });
    if (request.status !== 'pending') return res.status(400).json({ msg: "该申请已被处理" });

    // 2. 找到申请人
    const targetUser = await User.findById(request.user);
    if (!targetUser) return res.status(404).json({ msg: "申请用户已注销" });

    // 3. 🔥 执行“开小灶”逻辑 (Grant Permission)
    // 使用 $addToSet 确保不重复添加
    if (!targetUser.extraPermissions.includes(request.permission)) {
      targetUser.extraPermissions.push(request.permission);
      await targetUser.save();
    }

    // 4. 更新申请单状态
    request.status = 'approved';
    request.reviewedBy = req.user.id;
    request.reviewedAt = new Date();
    await request.save();

    res.json({ 
      success: true, 
      msg: `已批准！用户 ${targetUser.displayName} 获得了 ${request.permission} 权限`,
      requestId: request._id
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// =================================================================
// 4. 审批拒绝 (Super Admin Only)
// =================================================================
// @route   PUT /api/permission-requests/:id/reject
router.put("/:id/reject", auth, checkPermission('*'), async (req, res) => {
  try {
    const request = await PermissionRequest.findById(req.params.id);
    
    if (!request) return res.status(404).json({ msg: "申请单不存在" });
    if (request.status !== 'pending') return res.status(400).json({ msg: "该申请已被处理" });

    // 更新状态
    request.status = 'rejected';
    request.reviewedBy = req.user.id;
    request.reviewedAt = new Date();
    await request.save();

    res.json({ success: true, msg: "已拒绝该申请" });

  } catch (err) {
    res.status(500).send("Server Error");
  }
});

module.exports = router;