import { Router } from 'express';
const router = Router();
import K from '../config/permissionKeys.js';

// 引入模型
import PermissionRequest from '../models/PermissionRequest.js';
import User from '../models/User.js';

// =================================================================
// 1. 提交申请 (任何登录用户)
// =================================================================
// @route   POST /api/permission-requests
// @body    { permission: 'fitness:read_all', reason: '...' }
router.post('/', async (req, res) => {
  const { permission, reason } = req.body;

  // 1. 校验权限 Key 是否合法 (防止瞎填)
  const validKeys = Object.values(K);
  if (!validKeys.includes(permission)) {
    return res.status(400).json({ msg: '无效的权限 Key' });
  }

  try {
    const user = await User.findById(req.user.id);

    // 2. 检查用户是否已经拥有该权限
    // 注意：这里简单检查 extraPermissions，如果他在 role 里已有，也可以申请被拒
    if (user.extraPermissions.includes(permission)) {
      return res.status(400).json({ msg: '你已经拥有该权限，无需申请' });
    }

    // 3. 检查是否已经有待审批的同类申请 (防止狂点)
    const existingReq = await PermissionRequest.findOne({
      user: req.user.id,
      permission: permission,
      status: 'pending'
    });

    if (existingReq) {
      return res.status(400).json({ msg: '申请审核中，请耐心等待' });
    }

    // 4. 创建申请单
    const newRequest = new PermissionRequest({
      user: req.user.id,
      permission,
      reason
    });

    await newRequest.save();

    res.json({ success: true, msg: '申请已提交，请联系超级管理员审批' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 2. 提交【角色升级】申请 (例如申请成为 Admin)
// =================================================================
// @route   POST /api/permission-requests/role
// @body    { role: 'admin', reason: '我想协助管理社区' }
router.post('/role', async (req, res) => {
  const { role, reason } = req.body;

  // 1. 允许申请的角色列表
  // 通常不开放申请 super_admin，只开放申请 admin 或 bot
  const ALLOWED_ROLES = ['admin', 'bot'];

  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ msg: '不支持申请该角色' });
  }

  try {
    const user = await User.findById(req.user.id);

    // 2. 检查用户当前角色
    if (user.role === role) {
      return res.status(400).json({ msg: `你已经是 ${role} 了，无需申请` });
    }

    // 3. 检查是否已经是 Super Admin (降级不需要申请，直接自己改或者找人)
    if (user.role === 'super_admin') {
      return res.status(400).json({ msg: '你是超级管理员，无需申请角色' });
    }

    // 4. 检查是否有待审批的同类型申请
    const existingReq = await PermissionRequest.findOne({
      user: req.user.id,
      type: 'role', // 🔥 查角色申请
      permission: role, // 这里复用 permission 字段存角色名
      status: 'pending'
    });

    if (existingReq) {
      return res.status(400).json({ msg: '角色升级审核中，请耐心等待' });
    }

    // 5. 创建申请单
    const newRequest = new PermissionRequest({
      user: req.user.id,
      type: 'role', // 🔥 标记为角色申请
      permission: role, // 存目标角色
      reason
    });

    await newRequest.save();

    res.json({ success: true, msg: `申请成为 ${role} 已提交，请等待审批` });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 2. 获取申请列表 (Super Admin Only)
// =================================================================
// @route   GET /api/permission-requests?status=pending
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};

    // 默认只看待审批的，也可以传 'approved' 看历史
    if (status) {
      query.status = status;
    }

    const requests = await PermissionRequest.find(query)
      .populate('user', 'displayName email photoURL role') // 显示申请人信息
      .sort({ createdAt: -1 }); // 最新的在前面

    res.json(requests);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 3. 审批通过 (Super Admin Only) - 🔥 智能处理 Role 和 Permission
// =================================================================
router.put('/:id/approve', async (req, res) => {
  try {
    const request = await PermissionRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ msg: '申请单不存在' });
    if (request.status !== 'pending') return res.status(400).json({ msg: '该申请已被处理' });

    const targetUser = await User.findById(request.user);
    if (!targetUser) return res.status(404).json({ msg: '申请用户已注销' });

    // 🔥🔥🔥 核心分支逻辑 🔥🔥🔥

    // 分支 A: 如果是【角色申请】
    if (request.type === 'role') {
      const newRole = request.permission; // 也就是存进去的 'admin'

      // 防止重复操作
      if (targetUser.role === newRole) {
        return res.status(400).json({ msg: '用户已经是该角色了' });
      }

      targetUser.role = newRole; // 修改角色
      // (Only role is authoritative; no VIP pre-save hook)
    }

    // 分支 B: 如果是【权限申请】 (默认)
    else {
      const newPerm = request.permission; // 例如 'fitness:read_all'

      // 使用 addToSet 防止重复
      if (!targetUser.extraPermissions.includes(newPerm)) {
        targetUser.extraPermissions.push(newPerm);
      }
    }

    // 保存更改
    await targetUser.save();

    // 更新申请单状态
    request.status = 'approved';
    request.reviewedBy = req.user.id;
    request.reviewedAt = new Date();
    await request.save();

    res.json({
      success: true,
      msg: `审批通过！用户已更新为 [${request.type === 'role' ? request.permission : '特权模式'}]`,
      user: {
        id: targetUser.id,
        role: targetUser.role,
        permissions: targetUser.extraPermissions
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 4. 审批拒绝 (Super Admin Only)
// =================================================================
// @route   PUT /api/permission-requests/:id/reject
router.put('/:id/reject', async (req, res) => {
  try {
    const request = await PermissionRequest.findById(req.params.id);

    if (!request) return res.status(404).json({ msg: '申请单不存在' });
    if (request.status !== 'pending') return res.status(400).json({ msg: '该申请已被处理' });

    // 更新状态
    request.status = 'rejected';
    request.reviewedBy = req.user.id;
    request.reviewedAt = new Date();
    await request.save();

    res.json({ success: true, msg: '已拒绝该申请' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

export default router;
