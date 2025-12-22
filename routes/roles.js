import { Router } from 'express';
const router = Router();
import Role from '../models/Role.js';
import Permission from '../models/Permission.js'; // 用于校验权限Key是否真实存在
import permissionService from '../services/permissionService.js'; // 用于刷新内存缓存

// =================================================================
// 🔧 辅助函数
// =================================================================

/**
 * 校验权限列表是否有效
 * 作用：防止管理员手抖输入了数据库里不存在的权限 Key
 * @param {Array} permissions - 待校验的权限 Key 数组
 * @returns {Promise<Object>} - { valid: boolean, invalidKeys: Array }
 */
async function validatePermissions(permissions) {
  if (!permissions || permissions.length === 0) return { valid: true };

  // 1. 允许通配符 '*' 直接通过，不需要在 Permission 表里定义
  const filteredPerms = permissions.filter((p) => p !== '*');

  if (filteredPerms.length === 0) return { valid: true };

  // 2. 去 Permission 表查这些 Key 是否存在
  const validDocs = await Permission.find({ key: { $in: filteredPerms } }).select('key');
  const validKeys = validDocs.map((p) => p.key);

  // 3. 找出哪些是无效的 (前端传了但数据库没定义的)
  const invalidKeys = filteredPerms.filter((p) => !validKeys.includes(p));

  if (invalidKeys.length > 0) {
    return { valid: false, invalidKeys };
  }
  return { valid: true };
}

// =================================================================
// 1. 获取所有角色
// =================================================================

/**
 * @route   GET /api/roles
 * @desc    获取系统中定义的所有角色列表
 * @access  Super Admin
 */
router.get('/', async (req, res) => {
  try {
    const roles = await Role.find().sort({ name: 1 }); // 按名称 A-Z 排序
    res.json(roles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// =================================================================
// 2. 创建新角色
// =================================================================

/**
 * @route   POST /api/roles
 * @desc    创建一个新的角色
 * @body    { name: "vip_user", description: "付费会员", permissions: ["FITNESS_USE"] }
 * @access  Super Admin
 */
router.post('/', async (req, res) => {
  try {
    const { name, description, permissions } = req.body;

    // 1. 检查角色名是否已存在
    let role = await Role.findOne({ name });
    if (role) {
      return res.status(400).json({ msg: '角色名称已存在' });
    }

    // 2. ✅ 防呆校验：确保权限 Key 是真实存在的
    const check = await validatePermissions(permissions);
    if (!check.valid) {
      return res.status(400).json({
        msg: '包含无效的权限 Key，请先在权限管理中创建这些权限',
        invalidKeys: check.invalidKeys
      });
    }

    // 3. 创建角色
    role = new Role({
      name,
      description,
      permissions: permissions || []
    });

    await role.save();

    // 4. 🔥 刷新缓存：让新角色立即生效，无需重启服务器
    await permissionService.reload();

    res.json({ msg: '角色创建成功', data: role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// =================================================================
// 3. 修改角色权限
// =================================================================

/**
 * @route   PUT /api/roles/:name
 * @desc    修改指定角色的权限列表或描述
 * @param   name - 角色名称 (如 admin)
 * @body    { permissions: ["FITNESS_USE"], description: "..." }
 * @access  Super Admin
 */
router.put('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    let { permissions, description } = req.body;

    // 🔥🔥🔥 新增：数据清洗 (转大写 + 去重) 🔥🔥🔥
    if (permissions && Array.isArray(permissions)) {
      permissions = [...new Set(permissions.map((p) => p.toUpperCase()))];
    }

    // 🛡️ 保护机制：防止把自己锁死
    // 如果修改的是 super_admin，必须确保它依然拥有 '*' 权限
    if (name === 'super_admin' && permissions) {
      if (!permissions.includes('*')) {
        return res.status(400).json({ msg: "操作拒绝：超级管理员必须拥有 '*' (通配符) 权限" });
      }
    }

    // 1. ✅ 防呆校验
    if (permissions) {
      const check = await validatePermissions(permissions);
      if (!check.valid) {
        return res.status(400).json({
          msg: '包含无效的权限 Key',
          invalidKeys: check.invalidKeys
        });
      }
    }

    // 2. 更新数据库
    const updatedRole = await Role.findOneAndUpdate(
      { name: name },
      {
        permissions: permissions,
        description: description,
        updatedAt: Date.now()
      },
      { new: true }
    );

    if (!updatedRole) {
      return res.status(404).json({ msg: '角色不存在' });
    }

    // 3. 🔥 刷新缓存
    await permissionService.reload();

    res.json({ msg: `角色 [${name}] 更新成功`, data: updatedRole });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// =================================================================
// 4. 删除角色
// =================================================================

/**
 * @route   DELETE /api/roles/:name
 * @desc    删除一个角色
 * @param   name - 角色名称
 * @access  Super Admin
 */
router.delete('/:name', async (req, res) => {
  try {
    const { name } = req.params;

    // ✅ 核心保护：禁止删除系统内置的关键角色
    const PROTECTED_ROLES = ['super_admin', 'user', 'bot'];

    if (PROTECTED_ROLES.includes(name)) {
      return res.status(400).json({
        msg: `操作被拒绝：[${name}] 是系统内置核心角色，无法删除`
      });
    }

    const result = await Role.findOneAndDelete({ name });

    if (!result) {
      return res.status(404).json({ msg: '角色不存在' });
    }

    // 🔥 刷新缓存：因为角色没了，缓存里的映射也需要清除
    await permissionService.reload();

    res.json({ msg: `角色 [${name}] 已删除` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

export default router;
