const PERMISSIONS = require('../config/permissions');

module.exports = function (requiredPerm) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                msg: "未授权"
            });
        }

        const user = req.user;
        const userRole = user.role || 'user';

        // 🔥🔥🔥 加上这段 Debug 日志 🔥🔥🔥
        console.log('=============== 权限调试 ===============');
        console.log(`1. 你的 Token 里的身份: [${userRole}]`); // <--- 如果这里打印 'user'，说明必须要重新登录
        console.log(`2. 你的 Token 里的 ID: ${user.id}`);
        console.log(`3. 接口要求的权限: [${requiredPerm}]`);

        // 1. 获取角色自带的权限 (来自 config/permissions.js)
        const rolePerms = PERMISSIONS[userRole] || [];
        console.log(`4. 配置文件里该角色的权限:`, rolePerms);
        // 2. 获取用户个人的特权 (来自 数据库 user.extraPermissions)
        const extraPerms = user.extraPermissions || [];
     
        // 3. 🔥 合并权限池
        const allPerms = [...rolePerms, ...extraPerms];
        console.log(`5. 最终计算出的权限池:`, allPerms);
        // 为了方便后续路由使用，我们可以把合并后的权限挂在 req 上 (可选，但推荐)
        req.userPermissions = allPerms;

        // 4. 判断逻辑
        // A. 上帝 (Super Admin)
        if (allPerms.includes('*')) {
            console.log('✅ 验证通过');
            return next();
        }

        // B. 有具体权限
        if (allPerms.includes(requiredPerm)) {
            console.log('✅ 验证通过');
            return next();
        }

        console.warn(`⛔ [Access Denied] User: ${user.id} needs ${requiredPerm}`);
        return res.status(403).json({
            msg: "权限不足"
        });
    };
};