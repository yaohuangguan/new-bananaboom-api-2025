/**
 * @module middleware/globalGuard
 * @description 全局路由权限守卫 - 配合 PermissionService 实现秒级权限拦截
 * * 核心职责：
 * 1. 接收 Auth 中间件传递的 req.user (可能为 null)。
 * 2. 匹配 ROUTE_MAP 路由表。
 * 3. 决定放行 (next)、未登录拦截 (401) 或 越权拦截 (403)。
 */

import permissionService from '../services/permissionService.js';
import ROUTE_MAP from '../config/routeGuardMap.js';

const globalGuard = async (req, res, next) => {
  try {
    // ============================================================
    // 1. 提取请求元数据 (标准化路径)
    // ============================================================
    // 使用 originalUrl 并去掉查询参数 (?foo=bar)，确保匹配最原始、完整的路径
    const currentPath = req.originalUrl.split('?')[0]; 
    const currentMethod = req.method.toUpperCase();

    // ============================================================
    // 2. 路由匹配 (核心算法)
    // ============================================================
    // 🔥 ROUTE_MAP 假设已预先排序 (具体路径在前，通配在后)
    // 利用 find 实现 Short-circuiting (找到即停)，性能最优
    const matchedRule = ROUTE_MAP.find((rule) => {
      // 2.1 方法匹配 (支持 ALL 或 具体方法)
      const methodMatch = !rule.method || rule.method === 'ALL' || rule.method === currentMethod;
      if (!methodMatch) return false;

      // 2.2 路径匹配 (正则 > 字符串前缀)
      if (rule.regex) return rule.regex.test(currentPath);
      return currentPath.startsWith(rule.path);
    });

    // ============================================================
    // 情况 A: 未命中任何规则 -> 默认放行 (宽松模式)
    // ============================================================
    // ⚠️ 生产环境建议改为严格模式 (即 return 404/403)，但目前保持宽松以免误伤
    if (!matchedRule) {
      return next();
    }

    // ============================================================
    // 情况 B: 公开接口 (Public) -> 🟢 直接放行
    // ============================================================
    // 比如：登录、注册、公开博客文章
    // 哪怕 req.user 是 null，这里也会放行，完美解决登录死锁问题
    if (matchedRule.public === true) {
      return next();
    }

    // ============================================================
    // 情况 C: 私有接口但未登录 -> 🔴 401 拦截
    // ============================================================
    // Auth 中间件虽然放行了游客，但 Guard 发现此路由不是 Public，必须拦截！
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: Please login first',
        message_cn: '请先登录'
      });
    }

    // ============================================================
    // 情况 D: 仅需登录，无需特定权限 Key -> 🟢 放行
    // ============================================================
    // 比如：修改个人头像、查看自己资料
    if (!matchedRule.permission) {
      return next();
    }

    // ============================================================
    // 情况 E: 核心权限查验 (RBAC)
    // ============================================================
    const requiredPerm = matchedRule.permission;

    // 🔥 容错处理：理论上 Auth 已注入 permissions，但防止数据损坏
    let userPerms = req.user.permissions;
    if (!userPerms || !Array.isArray(userPerms)) {
      console.warn(`⚠️ [Guard] User permissions missing/invalid, recalculating for: ${req.user.email}`);
      // 加上 await 防止 Service 是异步查询数据库的
      userPerms = await permissionService.getUserMergedPermissions(req.user);
    }

    // 判定逻辑：
    // 1. 超级管理员 (Super Admin)
    // 2. 拥有通配符权限 ('*')
    // 3. 拥有目标权限 Key
    const isSuperAdmin = req.user.role === 'super_admin' || userPerms.includes('*');
    const hasPermission = userPerms.includes(requiredPerm);

    if (isSuperAdmin || hasPermission) {
      // ✅ 权限满足，放行
      return next();
    }

    // ============================================================
    // 情况 F: 权限不足 -> 🔴 403 拦截
    // ============================================================
    // 审计日志：记录越权尝试 (这是安全监控的重点)
    console.warn(`⛔ [Forbidden] Access Denied:
      - User: ${req.user.email} (Role: ${req.user.role})
      - Action: ${currentMethod} ${currentPath}
      - Required: "${requiredPerm}"
      - Time: ${new Date().toISOString()}
    `);

    return res.status(403).json({
      success: false,
      message: 'Access Denied: You do not have permission',
      message_cn: '权限不足：您没有操作该功能的权限',
      code: 'PERMISSION_DENIED',
      required: requiredPerm // 前端可根据此字段动态隐藏按钮或提示
    });

  } catch (error) {
    console.error('🔥 [GlobalGuard Critical Error]:', error);
    // 只有 Guard 炸了才会走到这里，通常是 RouteMap 格式写错了
    res.status(500).json({
      success: false,
      message: 'Server Internal Error (Guard)',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export default globalGuard;