import { Router } from 'express';
const router = Router();
import Permission from '../models/Permission.js';
import Role from '../models/Role.js';
import permissionService from '../services/permissionService.js'; // 引入服务

// =================================================================
// 1. [GET] 获取所有权限定义
// @route   GET /api/permissions
// @desc    用于前端渲染“权限勾选列表”
// =================================================================
router.get('/', async (req, res) => {
  try {
    // 按分类和 Key 排序，让前端显示更整齐
    const perms = await Permission.find().sort({ category: 1, key: 1 });
    res.json(perms);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// =================================================================
// 2. [POST] 注册新权限
// @route   POST /api/permissions
// @body    { key: "AI_CHAT_USE", name: "使用AI聊天", category: "BOT" }
// =================================================================
router.post('/', async (req, res) => {
  try {
    const { key, name, description, category } = req.body;

    // 规范：权限 Key 强制大写
    const upperKey = key.toUpperCase().trim();

    // 查重
    let perm = await Permission.findOne({ key: upperKey });
    if (perm) {
      return res.status(400).json({ msg: `权限 Key [${upperKey}] 已存在` });
    }

    perm = new Permission({
      key: upperKey,
      name,
      description,
      category: category || 'General'
    });

    await perm.save();

    // 注意：仅仅创建权限定义，不需要刷新 Role 缓存，因为还没有 Role 用到它。

    res.json({ msg: '权限创建成功', data: perm });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// =================================================================
// 3. [PUT] 修改权限描述
// @route   PUT /api/permissions/:key
// @desc    注意：不建议修改 key 本身，只修名称和描述
// =================================================================
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { name, description, category } = req.body;

    const perm = await Permission.findOneAndUpdate({ key: key }, { name, description, category }, { new: true });

    if (!perm) return res.status(404).json({ msg: '权限不存在' });

    res.json({ msg: '权限更新成功', data: perm });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// =================================================================
// 4. [DELETE] 删除权限 (⚠️级联删除⚠️)
// @route   DELETE /api/permissions/:key
// @desc    删除权限定义，并从所有拥有该权限的角色中移除它
// =================================================================
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;

    // 1. 删除 Permission 表里的记录
    const perm = await Permission.findOneAndDelete({ key });

    if (!perm) {
      return res.status(404).json({ msg: '权限不存在' });
    }

    // 2. 🔥🔥🔥 级联清理 (Cascade Delete)
    // 如果不删这个，Role 表的 permissions 数组里会留着无效的字符串
    const updateResult = await Role.updateMany(
      { permissions: key }, // 查找所有包含此 Key 的角色
      { $pull: { permissions: key } } // 从数组中移除此 Key
    );

    console.log(`🧹 已清理僵尸权限，影响角色数: ${updateResult.modifiedCount}`);

    // 3. 🔥🔥🔥 核心：因为修改了 Role 表的数据，必须刷新缓存
    await permissionService.reload();

    res.json({
      msg: `权限 [${key}] 已彻底删除，并已从 ${updateResult.modifiedCount} 个角色中移除`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

export default router;
