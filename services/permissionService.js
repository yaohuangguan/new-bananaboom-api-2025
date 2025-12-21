/**
 * @module services/permissionService
 * @description RBAC 权限服务 - 处理角色权限缓存、用户最终权限合并及用户快照短缓存
 */

const Role = require('../models/Role');
const User = require('../models/User'); // 必须引入 User 模型进行实时查询
const systemCache = require('../utils/cache'); // 引入你现有的 node-cache 实例

class PermissionService {
    constructor() {
        this.roleCache = {}; // 内存缓存: { 'admin': ['FITNESS_USE', ...], 'user': [...] }
        this.isLoaded = false;
        this.USER_CACHE_PREFIX = "USER_LIVE_"; // 缓存键前缀
        this.USER_CACHE_TTL = 5; // 5秒极短缓存，平衡实时性与数据库压力
    }

    /**
     * 从数据库全量加载角色权限配置到内存
     * 系统启动或手动 reload 时调用
     */
    async load() {
        try {
            console.log("🔄 正在加载 RBAC 角色权限配置...");
            const roles = await Role.find({});

            const newCache = {};
            roles.forEach(role => {
                // 将角色名作为 key，权限数组作为 value 存入内存
                newCache[role.name] = role.permissions || [];
            });

            this.roleCache = newCache;
            this.isLoaded = true;
            console.log(`✅ RBAC 权限加载完成。当前已缓存角色: [${Object.keys(newCache).join(', ')}]`);
        } catch (err) {
            console.error("❌ 加载权限配置失败:", err);
        }
    }

    /**
     * 获取指定角色的权限列表 (内部内存查询)
     * @param {String} roleName 
     */
    getPermissions(roleName) {
        if (!this.isLoaded) {
            console.warn("⚠️ 警告: 权限服务尚未初始化，返回空权限列表");
            return [];
        }
        return this.roleCache[roleName] || [];
    }

    /**
     * 刷新角色权限定义缓存
     */
    async reload() {
        await this.load();
    }

    /**
     * 🔥🔥🔥 核心封装：计算用户的最终权限集合
     * 逻辑：角色权限 + 个人额外特权 = 去重后的全集
     * @param {Object} user - 用户对象 (必须包含 .role 和 .extraPermissions)
     */
    getUserMergedPermissions(user) {
        if (!user) return [];

        const userRole = user.role || 'user';

        // 1. 从内存拿该角色的基础权限
        const rolePerms = this.getPermissions(userRole);

        // 2. 从用户对象拿存储在数据库的额外特权 (extraPermissions)
        const extraPerms = user.extraPermissions || [];

        // 3. 合并并使用 Set 去重
        return [...new Set([...rolePerms, ...extraPerms])];
    }

    /**
     * 🛠️ 统一 Payload 构造器
     * 确保全应用所有地方生成的 User 快照字段完全一致，防止字段缺失
     * @param {Object} user - 数据库 User 文档对象 (Mongoose Object)
     */
    buildUserPayload(user) {
        if (!user) return null;

        return {
            id: user.id || user._id.toString(),
            displayName: user.displayName,
            name: user.displayName, // 兼容前端旧逻辑中的 name 字段
            email: user.email,
            phone: user.phone || "",
            photoURL: user.photoURL || "",
            vip: user.vip || false,
            role: user.role || "user",
            extraPermissions: user.extraPermissions || [], // 保留原数组供后续可能的逻辑使用
            // 🔥 注入实时合并计算后的最终权限数组
            permissions: this.getUserMergedPermissions(user)
        };
    }

    /**
     * 🚀 增强方法：获取实时且字段完整的用户 Payload (带 5 秒内存缓存)
     * 解决了“Session 只存 Token”时查库慢的问题，同时保证了“字段不炸”和“权限准实时”
     * @param {String} userId 
     */
    async getLiveUserPayload(userId) {
        if (!userId) return null;

        const cacheKey = this.USER_CACHE_PREFIX + userId;

        // 1. 尝试从 node-cache 获取
        const cachedPayload = systemCache.get(cacheKey);
        if (cachedPayload) {
            return cachedPayload;
        }

        // 2. 缓存失效，实时查询数据库
        // 使用 select 排除密码等敏感信息，确保获取到最新最全的字段
        const user = await User.findById(userId).select("-password -__v -googleId");
        if (!user) return null;

        // 3. 使用统一构造器生成 Payload
        const payload = this.buildUserPayload(user);

        // 4. 存入 node-cache，设置 5 秒 TTL
        // 这意味着 5 秒内的连续请求将不再击穿数据库
        systemCache.set(cacheKey, payload, this.USER_CACHE_TTL);

        return payload;
    }

    /**
     * 🧹 手动清理指定用户的 Payload 缓存
     * 当管理员修改了该用户的角色或权限时，应立即调用此方法
     * @param {String} userId 
     */
    clearUserCache(userId) {
        systemCache.del(this.USER_CACHE_PREFIX + userId);
        console.log(`🧹 已清理用户 ${userId} 的实时权限缓存`);
    }
}

// 导出单例，确保全应用共享同一份角色权限缓存和用户短缓存
module.exports = new PermissionService();