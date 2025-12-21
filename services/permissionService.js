/**
 * @module services/permissionService
 * @description 权限与用户信息统一工厂
 */
const User = require('../models/User');
const Role = require('../models/Role'); // 确保引入了角色模型
const systemCache = require('../cache/memoryCache');

class PermissionService {
    constructor() {
        this.roleCache = {}; // 存储角色与权限的映射: { 'admin': ['POST_EDIT', 'USER_LIST'] }
        this.isLoaded = false;
    }

    /**
     * 系统启动时加载所有角色权限到内存
     */
    async load() {
        try {
            const roles = await Role.find({});
            const newCache = {};
            roles.forEach(r => {
                newCache[r.name] = r.permissions || [];
            });
            this.roleCache = newCache;
            this.isLoaded = true;
            console.log("✅ 权限服务初始化成功");
        } catch (err) {
            console.error("❌ 权限加载失败:", err);
        }
    }

    /**
     * 🔥 核心逻辑：计算用户的最终权限全集
     * 规则：基础角色权限 + 个人额外分配的特权
     */
    getUserMergedPermissions(user) {
        if (!user) return [];
        
        // 1. 获取角色基础权限 (从内存缓存拿，快！)
        const roleName = user.role || 'user';
        const rolePerms = this.roleCache[roleName] || [];

        // 2. 获取用户文档里的个人特权
        const extraPerms = user.extraPermissions || [];

        // 3. 合并并去重
        return [...new Set([...rolePerms, ...extraPerms])];
    }

    /**
     * 🛠️ 统一 Payload 构造器 (全应用唯一结构定义)
     * 这一步确保了：返回给前端的数据 = 签入 JWT 的数据 = auth 补全的数据
     */
    buildUserPayload(user) {
        if (!user) return null;

        // 预先计算合并后的权限
        const finalPermissions = this.getUserMergedPermissions(user);

        return {
            id: user.id || user._id.toString(),
            _id: user.id || user._id.toString(), // 兼容性：双 ID
            displayName: user.displayName,
            name: user.displayName, 
            email: user.email,
            phone: user.phone || "",
            photoURL: user.photoURL || "",
            vip: user.vip || false,
            role: user.role || "user",
            extraPermissions: user.extraPermissions || [], 
            // 🔥 注入最新的合并权限数组
            // 解决你担心的“前端拿不到最新权限”或“字段重复”问题
            permissions: finalPermissions 
        };
    }

    /**
     * 🚀 异步补全方法：供 auth 中间件使用 (带 5s 缓存)
     */
    async getLiveUserPayload(userId) {
        const cacheKey = `USER_LIVE_${userId}`;
        const cached = systemCache.get(cacheKey);
        if (cached) return cached;

        // 查库补全
        const user = await User.findById(userId).select("-password -__v");
        if (!user) return null;

        // 🔥 统一调用上面的构造器
        const payload = this.buildUserPayload(user);
        
        // 存入 5 秒缓存，防止高频点击炸掉数据库
        systemCache.set(cacheKey, payload, 5); 
        return payload;
    }

    /**
     * 🧹 清理指定用户的权限缓存
     * 管理员改权限后必须调这个，实现“秒级生效”
     */
    clearUserCache(userId) {
        systemCache.del(`USER_LIVE_${userId}`);
    }
}

module.exports = new PermissionService();