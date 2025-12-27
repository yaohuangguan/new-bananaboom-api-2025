import { Router } from 'express';
import AuditLog from '../models/AuditLog.js';
import auth from '../middleware/auth.js'; // 🔥 必须引入鉴权中间件

const router = Router();

/**
 * =================================================================
 * GET /api/audit/options
 * 获取筛选器的选项 (给前端下拉框用)
 * =================================================================
 * 返回数据库中所有出现过的 action 类型，供前端渲染 Select 组件
 */
router.get('/options', auth, async (req, res) => {
  try {
    // 使用 distinct 获取所有不重复的操作类型
    const actions = await AuditLog.distinct('action');
    res.json({ actions: actions.sort() });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

/**
 * =================================================================
 * GET /api/audit
 * 获取日志列表 (支持分页、筛选、权限控制)
 * =================================================================
 */
router.get('/', auth, async (req, res) => {
  try {
    // 1. 分页参数
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2. 筛选参数
    const {
      action,
      target,
      ip,
      operator, // 前端传来的想要查看的用户ID
      startDate,
      endDate
    } = req.query;

    // 3. 构建 MongoDB 查询对象
    const query = {};

    // 🔥🔥🔥 核心权限控制 🔥🔥🔥
    // 如果是 Super Admin，允许查看任何人 (使用前端传的 operator 或查全部)
    // 如果是 普通用户，强制锁定 operator 为自己 (无视前端传的 operator)
    if (req.user.role === 'super_admin') {
      if (operator) {
        query.operator = operator;
      }
    } else {
      // 普通用户只能看自己的流水
      query.operator = req.user.id;
    }

    // A. 操作类型 (精确匹配)
    if (action) {
      query.action = action;
    }

    // B. 操作对象 (模糊搜索)
    if (target) {
      query.target = { $regex: target, $options: 'i' };
    }

    // C. IP (模糊搜索)
    if (ip) {
      query.ip = { $regex: ip, $options: 'i' };
    }

    // D. 时间范围
    if (startDate || endDate) {
      query.createdDate = {};
      if (startDate) {
        query.createdDate.$gte = new Date(startDate);
      }
      if (endDate) {
        // 技巧：如果前端只传日期 "2025-12-27"，new Date 会是 00:00:00
        // 为了包含当天，我们通常把结束时间设为当天的最后一毫秒，或者让前端传下一天的 00:00
        // 这里假设前端传的是标准 ISO 格式，或者我们简单处理：
        const end = new Date(endDate);
        // 如果没有具体时间，手动设为当天的 23:59:59 (可选优化)
        // end.setHours(23, 59, 59, 999); 
        query.createdDate.$lte = end;
      }
    }

    // 4. 执行查询
    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdDate: -1 }) // 最新在前
        .skip(skip)
        .limit(limit)
        // 🔥 关联查询：带出操作人的头像和名字
        .populate('operator', 'displayName photoURL email role'),

      AuditLog.countDocuments(query)
    ]);

    // 5. 返回结果
    res.json({
      data: logs,
      pagination: {
        currentPage: page,
        limit: limit,
        totalPages: Math.ceil(total / limit),
        totalLogCount: total
      }
    });

  } catch (error) {
    console.error('Audit Log Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

/**
 * =================================================================
 * DELETE /api/audit/:id
 * 删除单条日志 (仅限 Super Admin)
 * =================================================================
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ msg: '无权操作' });
    }

    const log = await AuditLog.findById(req.params.id);
    if (!log) return res.status(404).json({ msg: 'Log not found' });

    await log.deleteOne();
    res.json({ success: true, msg: 'Log deleted' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

/**
 * =================================================================
 * DELETE /api/audit/prune/old
 * 清理 90 天前的所有日志 (仅限 Super Admin)
 * =================================================================
 * 用于给管理员手动瘦身数据库
 */
router.delete('/prune/old', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ msg: '无权操作' });
    }

    const daysAgo = 90; // 可以做成参数
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - daysAgo);

    const result = await AuditLog.deleteMany({
      createdDate: { $lt: dateThreshold }
    });

    res.json({ 
      success: true, 
      msg: `已清理 ${daysAgo} 天前的日志`, 
      deletedCount: result.deletedCount 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

export default router;