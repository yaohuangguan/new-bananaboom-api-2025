/**
 * @module middleware/globalGuard
 * @description 全局路由权限守卫 - 配合 PermissionService 实现秒级权限拦截
 */

import permissionService from '../services/permissionService.js';
import ROUTE_MAP from '../config/routeGuardMap.js';

/**
 * 全局权限守卫中间件
 * 注意：此中间件必须挂载在 auth 中间件之后
 */
const globalGuard = async (req, res, next) => {
  try {
    // 1. 提取请求元数据
    const currentPath = (req.baseUrl || '') + req.path;
    const currentMethod = req.method.toUpperCase();

    // 🔥 此时 ROUTE_MAP 已经是按“具体程度”排好序的了
    // 只需要 O(n) 的线性查找，匹配到第一个就立即停止 (Short-circuiting)
    const matchedRule = ROUTE_MAP.find((rule) => {
      const methodMatch = !rule.method || rule.method === 'ALL' || rule.method === currentMethod;
      if (!methodMatch) return false;

      if (rule.regex) return rule.regex.test(currentPath);

      // 关键点：因为长路径在前，startsWith 命中即为“最具体匹配”
      return currentPath.startsWith(rule.path);
    });

    // ============================================================
    // 情况 A: 未命中任何规则 -> 默认放行 (宽松模式)
    // ============================================================
    if (!matchedRule) return next();

    // ============================================================
    // 情况 B: 公开接口 (Public) -> 🟢 直接放行
    // ============================================================
    if (matchedRule.public === true) return next();

    // ============================================================
    // 情况 C: 私有接口但未登录 (req.user 由 auth 中间件注入)
    // ============================================================
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: Please login first',
        message_cn: '请先登录'
      });
    }

    // ============================================================
    // 情况 D: 仅需登录，无需特定权限 Key
    // ============================================================
    if (!matchedRule.permission) return next();

    // ============================================================
    // 情况 E: 核心权限查验 (使用 PermissionService 确保数据准确)
    // ============================================================
    const requiredPerm = matchedRule.permission;

    // 🔥 [核心改动] 这里的 permissions 优先从 req.user 拿 (auth 已经补全过)
    // 如果由于某种原因缺失，则调用 service 现场计算
    let userPerms = req.user.permissions;
    if (!userPerms) {
      console.warn(`⚠️ [Guard] User permissions missing in req.user, recalculating for: ${req.user.email}`);
      userPerms = permissionService.getUserMergedPermissions(req.user);
    }

    // 1. 超管/通配符判定
    const isSuperAdmin = req.user.role === 'super_admin' || userPerms.includes('*');

    // 2. 权限 Key 判定
    if (isSuperAdmin || userPerms.includes(requiredPerm)) {
      // ✅ 拥有权限，放行
      return next();
    }

    // ============================================================
    // 情况 F: 权限不足 -> 🔴 403 拦截
    // ============================================================
    // 审计日志：记录越权尝试
    console.warn(`⛔ [Forbidden] Access Denied:
      Time: ${new Date().toLocaleString()}
      User: ${req.user.email} (Role: ${req.user.role})
      Path: ${currentMethod} ${currentPath}
      Required Key: ${requiredPerm}
    `);

    return res.status(403).json({
      success: false,
      message: 'Access Denied: You do not have permission for this action',
      message_cn: '权限不足：您没有操作该功能的权限',
      code: 'PERMISSION_DENIED',
      required: requiredPerm // 传给前端用于动态隐藏 UI 按钮
    });
  } catch (error) {
    console.error('🔥 [GlobalGuard Critical Error]:', error);
    res.status(500).json({
      message: 'Guard Server Error'
    });
  }
};

export default globalGuard;
