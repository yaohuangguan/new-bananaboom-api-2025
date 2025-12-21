/**
 * @module middleware/globalGuard
 * @description 全局路由权限守卫 - 配合 PermissionService 的 5s 缓存补全逻辑
 */

const permissionService = require('../services/permissionService');
const ROUTE_MAP = require('../config/routeGuardMap');

const globalGuard = (req, res, next) => {
  // 1. 获取当前请求的元数据
  // req.baseUrl (挂载点如 /api) + req.path (子路径如 /users/:id/role)
  const currentPath = (req.baseUrl || '') + req.path; 
  const currentMethod = req.method.toUpperCase();

  // 2. 🔍 查找匹配规则 (Array.find 保证了优先级：数组靠前的规则先匹配)
  const matchedRule = ROUTE_MAP.find(rule => {
    // A. 校验 HTTP 方法匹配 (未定义或 ALL 则视为匹配)
    const methodMatch = !rule.method || rule.method === 'ALL' || rule.method === currentMethod;
    if (!methodMatch) return false;

    // B. 校验路径匹配 (正则优先级最高)
    if (rule.regex) {
      return rule.regex.test(currentPath);
    }
    
    // C. 校验路径匹配 (前缀匹配)
    return currentPath.startsWith(rule.path);
  });

  // ============================================================
  // 情况 A: 没有任何匹配规则 -> 默认放行 (宽松模式/黑盒模式)
  // ============================================================
  if (!matchedRule) {
    return next();
  }

  // ============================================================
  // 情况 B: 命中 Public 规则 -> 🟢 直接放行
  // ============================================================
  // 用于登录、注册、健康检查等不需要 Token 的接口
  if (matchedRule.public === true) {
    return next(); 
  }

  // ============================================================
  // 情况 C: 命中私有规则但未登录 -> 🔴 401
  // ============================================================
  // 此时 req.user 应该由前面的 auth 中间件补全
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      message: "Unauthorized: Please login first",
      message_cn: "请先登录后再进行操作"
    });
  }

  // ============================================================
  // 情况 D: 仅需登录即可访问 (permission 为 null/undefined)
  // ============================================================
  // 适用于个人资料修改、点赞等通用接口
  if (!matchedRule.permission) {
    return next();
  }

  // ============================================================
  // 情况 E: 核心权限查验 -> 🔴 403
  // ============================================================
  const requiredPerm = matchedRule.permission;
  
  // 🔥 实时性保障：这里的 permissions 是 auth 中间件从 5s 缓存或数据库中实时补全的
  const userPerms = req.user.permissions || [];

  // 1. 超管判定逻辑 (硬代码角色判定 或 拥有通配符 '*' 权限)
  const isSuperAdmin = req.user.role === 'super_admin' || userPerms.includes('*');

  // 2. 权限 Key 匹配
  if (isSuperAdmin || userPerms.includes(requiredPerm)) {
    // ✅ 匹配成功，放行
    return next();
  } else {
    // ⛔ 匹配失败，拦截并记录审计日志
    console.warn(`[Guard Intercept] --------------------------
      Status: 403 Forbidden
      User: ${req.user.email} (Role: ${req.user.role})
      Target: ${currentMethod} ${currentPath}
      Required: ${requiredPerm}
      UserPerms: ${userPerms.length > 5 ? userPerms.slice(0, 5) + '...' : userPerms}
    --------------------------------------------------`);

    return res.status(403).json({ 
      success: false,
      message: "Access Denied: Insufficient Permissions",
      message_cn: "权限不足：您没有执行此操作的权限",
      code: "PERMISSION_DENIED",
      required: requiredPerm // 方便前端判断该隐藏哪个按钮
    });
  }
};

module.exports = globalGuard;