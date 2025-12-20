const PERMISSIONS = require('../config/permissions');

module.exports = function(requiredPerm) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ msg: "未授权" });
    }

    const user = req.user;
    const userRole = user.role || 'user';

    // 1. 获取角色自带的权限 (来自 config/permissions.js)
    const rolePerms = PERMISSIONS[userRole] || [];

    // 2. 获取用户个人的特权 (来自 数据库 user.extraPermissions)
    const extraPerms = user.extraPermissions || [];

    // 3. 🔥 合并权限池
    const allPerms = [...rolePerms, ...extraPerms];

    // 为了方便后续路由使用，我们可以把合并后的权限挂在 req 上 (可选，但推荐)
    req.userPermissions = allPerms;

    // 4. 判断逻辑
    // A. 上帝 (Super Admin)
    if (allPerms.includes('*')) {
      return next();
    }

    // B. 有具体权限
    if (allPerms.includes(requiredPerm)) {
      return next();
    }

    console.warn(`⛔ [Access Denied] User: ${user.id} needs ${requiredPerm}`);
    return res.status(403).json({ msg: "权限不足" });
  };
};