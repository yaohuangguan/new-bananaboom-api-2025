const permissionService = require('../services/permissionService');
const ROUTE_MAP = require('../config/routeGuardMap');

const globalGuard = (req, res, next) => {
  // 1. 拼接完整路径 (去除 query 参数)
  // req.baseUrl 是挂载点 (如 /api)，req.path 是子路径 (如 /users/signin)
  const currentPath = req.baseUrl + req.path; 
  const currentMethod = req.method;

  // 2. 🔍 查找匹配规则
  const matchedRule = ROUTE_MAP.find(rule => {
    // 方法匹配
    const methodMatch = !rule.method || rule.method === 'ALL' || rule.method === currentMethod;
    if (!methodMatch) return false;

    // 路径匹配 (正则 > 前缀)
    if (rule.regex) {
      return rule.regex.test(currentPath);
    }
    return currentPath.startsWith(rule.path);
  });

  // ============================================================
  // 情况 A: 没有匹配到规则 -> 默认放行 (宽松模式)
  // ============================================================
  if (!matchedRule) {
    return next();
  }

  // ============================================================
  // 情况 B: 规则是 Public -> 直接放行
  // ============================================================
  // 这里的关键是：即使 auth 没解析出 user (req.user undefined)，这里也让过
  // 这样 登录/注册 接口才能正常工作
  if (matchedRule.public === true) {
    return next(); 
  }

  // ============================================================
  // 情况 C: 规则是私有的 -> 检查是否登录
  // ============================================================
  // 此时必须有 req.user，否则说明 auth 没通过 (或者是游客)
  if (!req.user) {
    return res.status(401).json({ msg: "Unauthorized: Login required" });
  }

  // ============================================================
  // 情况 D: 仅需登录，不需要额外权限
  // ============================================================
  if (!matchedRule.permission) {
    return next();
  }

  // ============================================================
  // 情况 E: 需要特定权限 -> 查票
  // ============================================================
  const requiredPerm = matchedRule.permission;
  const userPerms = permissionService.getUserMergedPermissions(req.user);

  // 🔥 超管(*) 或者 拥有具体权限
  if (userPerms.includes('*') || userPerms.includes(requiredPerm)) {
    return next();
  } else {
    console.warn(`⛔ [Guard] Blocked ${req.user.email} accessing ${currentPath}`);
    return res.status(403).json({ 
      msg: "Permission Denied", 
      required: requiredPerm 
    });
  }
};

module.exports = globalGuard;