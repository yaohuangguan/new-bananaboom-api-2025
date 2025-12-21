const Role = require('../models/Role');

class PermissionService {
    constructor() {
        this.roleCache = {}; // 内存缓存: { 'admin': ['FITNESS_USE', ...], 'user': [...] }
        this.isLoaded = false;
    }

    /**
     * 从数据库全量加载角色权限到内存
     * 注意：Role 表里存的是 permission keys 数组
     */
    async load() {
        try {
            console.log("🔄 正在加载 RBAC 权限配置...");
            const roles = await Role.find({});

            const newCache = {};
            roles.forEach(role => {
                // 直接把 key 数组存入缓存
                newCache[role.name] = role.permissions;
            });

            this.roleCache = newCache;
            this.isLoaded = true;
            console.log("✅ RBAC 权限加载完成。缓存角色数:", Object.keys(newCache).length);
        } catch (err) {
            console.error("❌ 加载权限失败:", err);
            // 这里不抛出错误，防止炸掉整个服务器，但需要记录日志
        }
    }

    /**
     * 获取指定角色的权限列表
     */
    getPermissions(roleName) {
        if (!this.isLoaded) {
            console.warn("⚠️ 警告: 权限服务尚未初始化，返回空权限");
            return [];
        }
        return this.roleCache[roleName] || [];
    }

    /**
     * 刷新缓存 (当后台修改了角色权限时调用)
     */
    async reload() {
        await this.load();
    }

    /**
     * 🔥🔥🔥 新增封装：计算用户的最终权限集合
     * 逻辑：角色权限 + 个人特权 = 去重后的全集
     * @param {Object} user - 用户对象 (必须包含 .role 和 .extraPermissions)
     * @returns {Array<String>} - 最终权限数组
     */
    getUserMergedPermissions(user) {
        if (!user) return [];

        const userRole = user.role || 'user';

        // 1. 从缓存拿角色的权限
        const rolePerms = this.getPermissions(userRole);

        // 2. 从用户对象拿特权
        const extraPerms = user.extraPermissions || [];

        // 3. 合并去重
        return [...new Set([...rolePerms, ...extraPerms])];
    }
}



// 导出单例，确保全应用共享一份缓存
module.exports = new PermissionService();