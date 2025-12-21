// middleware/checkPermission.js
const permissionService = require('../services/permissionService'); // 🔥 改动1: 引入权限服务

module.exports = function (requiredPerm) {
    return (req, res, next) => {
        // 1. 基础鉴权：确保用户已登录
        if (!req.user) {
            return res.status(401).json({
                msg: "未授权"
            });
        }

        const user = req.user;
        const userRole = user.role || 'user';

        // 🔥🔥🔥 Debug 日志 (保留并优化) 🔥🔥🔥
        console.log('=============== 权限调试 (DB Mode) ===============');
        console.log(`1. 用户身份: [${userRole}]`);
        console.log(`2. 用户 ID: ${user.id}`);
        console.log(`3. 接口需求: [${requiredPerm}]`);

        // ============================================================
        // 🔥 改动2: 从 Service (内存缓存) 获取角色权限
        // ============================================================
        // 以前是: const rolePerms = PERMISSIONS[userRole] || [];
        const rolePerms = permissionService.getPermissions(userRole);
        
        console.log(`4. [Role] 角色权限 (${rolePerms.length}):`, rolePerms);

        // ============================================================
        // 3. 获取用户个人的特权
        // ============================================================

        const extraPerms = user.extraPermissions || [];
        
        console.log(`5. [User] 个人特权:`, extraPerms);

        // ============================================================
        // 4. 合并权限池 (使用 Set 去重)
        // ============================================================
        const allPerms = [...new Set([...rolePerms, ...extraPerms])];
        
        // 挂载到 req 上，供后续业务逻辑查询 (比如 Fitness 接口里的 canReadAll 判断)
        req.userPermissions = allPerms;

        console.log(`6. 最终权限池:`, allPerms);

        // ============================================================
        // 5. 判断逻辑
        // ============================================================
        
        // A. 上帝 (Super Admin) - 通配符 '*'
        if (allPerms.includes('*')) {
            console.log('✅ 验证通过 (Super Admin / Wildcard)');
            return next();
        }

        // B. 有具体权限
        if (allPerms.includes(requiredPerm)) {
            console.log('✅ 验证通过 (Direct Match)');
            return next();
        }

        // C. 拒绝访问
        console.warn(`⛔ [Access Denied] User: ${user.id} (${user.name}) needs permission: ${requiredPerm}`);
        return res.status(403).json({
            msg: "权限不足",
            debug: {
                required: requiredPerm,
                yourRole: userRole
            }
        });
    };
};