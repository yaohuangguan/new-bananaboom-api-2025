const K = require('./permissionKeys');

/**
 * 🛡️ 全局路由权限守卫配置 (Route Guard Configuration)
 * * 🔍 匹配逻辑 (按数组顺序执行 Array.find):
 * 1. 优先匹配 regex (正则表达式)
 * 2. 其次匹配 path (前缀匹配 startsWith)
 * 3. 最后检查 method (必须精确匹配，未定义则默认为 ALL)
 * * 🔑 字段说明:
 * - public: true      -> 🟢 完全公开 (不校验 Token)
 * - permission: null  -> 🟡 仅需登录 (校验 Token，不校验具体权限)
 * - permission: 'KEY' -> 🔴 需要特定权限 (校验 Token + 校验 Permission Key)
 */
const ROUTE_MAP = [
    // ============================================================
    // Level 1: 纯公开基础设施 (Public Infrastructure)
    // ============================================================
    {
        path: '/health',
        method: 'GET',
        public: true
    }, // 健康检查

    // ============================================================
    // Level 2: 登录与注册入口 (Auth Entry)
    // ============================================================
    {
        path: '/api/auth',
        method: 'ALL',
        public: true
    },
    {
        path: '/api/users/signin',
        method: 'POST',
        public: true
    }, // 登录
    {
        path: '/api/users/reset-by-secret',
        method: 'POST',
        public: true
    }, // 暗号重置
    {
        path: '/api/users',
        method: 'POST',
        public: true
    }, // 注册 (注意：GET users 是列出用户，非公开)

    // ============================================================
    // Level 3: CMS 内容展示 (读公开 / 写鉴权)
    // ============================================================
    // 1. 简历/项目/主页 (写操作通常属于超管或博主)
    {
        path: '/api/resumes',
        method: 'GET',
        public: true
    },
    {
        path: '/api/resumes',
        method: 'ALL',
        permission: K.SUPER_ADMIN
    },

    {
        path: '/api/projects',
        method: 'GET',
        public: true
    },
    {
        path: '/api/projects',
        method: 'ALL',
        permission: K.SUPER_ADMIN
    },

    {
        path: '/api/homepage',
        method: 'GET',
        public: true
    },
    {
        path: '/api/homepage',
        method: 'ALL',
        permission: K.SUPER_ADMIN
    },

    // 2. 菜单管理 (你指定的 MENU:USE)
    {
        path: '/api/menu',
        method: 'GET',
        public: true
    },
    {
        path: '/api/menu',
        method: 'ALL',
        permission: K.MENU_USE
    }, // 🔥 新增权限

    // 3. 博客/评论/相册
    {
        path: '/api/posts',
        method: 'GET',
        public: true
    }, // 公开列表

    // ⚠️ [重要] 静态路径必须放在动态参数路径 /:id 之前
    // 虽然 Guard 主要是查表，但保持这个逻辑顺序是个好习惯
    {
        path: '/api/posts/private/posts',
        method: 'GET',
        permission: K.PRIVATE_POST_READ
    }, // 私有列表 (仅管理员)

    {
        path: '/api/posts/:id',
        method: 'GET',
        public: true
    }, // 单篇详情

    // =================================================================
    // ❤️ 2. 互动区域 (Likes)
    // =================================================================
    // 注意：你的代码中点赞接口目前没有加 auth 中间件，所以必须设为 PUBLIC。
    // 如果你给点赞加了 auth，这里可以改成 K.BLOG_INTERACT
    {
        path: '/api/posts/likes/:id',
        method: 'GET',
        public: true
    }, // 看赞
    {
        path: '/api/posts/likes/:id/add',
        method: 'POST',
        permission: null
    }, // 点赞
    {
        path: '/api/posts/likes/:id/remove',
        method: 'POST',
        permission: null
    }, // 取消点赞

    // =================================================================
    // 🛡️ 3. 管理区域 (Super Admin Only) - 增删改
    // =================================================================
    {
        path: '/api/posts',
        method: 'POST',
        permission: K.BLOG_MANAGE
    }, // 发帖

    {
        path: '/api/posts/:id',
        method: 'PUT',
        permission: K.BLOG_MANAGE
    }, // 改帖

    {
        path: '/api/posts/:id',
        method: 'DELETE',
        permission: K.BLOG_MANAGE
    }, // 删帖

    {
        path: '/api/comments',
        method: 'GET',
        public: true
    },
    {
        path: '/api/comments',
        method: 'ALL',
        permission: K.BLOG_INTERACT
    },

    {
        path: '/api/photos',
        method: 'GET',
        public: true
    },
    {
        path: '/api/photos',
        method: 'ALL',
        permission: K.CAPSULE_USE
    },

    // ============================================================
    // Level 4: Cloudinary 图片服务 (精细化分层控制)
    // ============================================================
    // ⚠️ 顺序非常重要：越具体的路径越要放在前面！

    // 1. 查看用量大盘 (高危敏感信息) -> 🔒 只有 Super Admin 能看
    {
        path: '/api/cloudinary/usage',
        method: 'GET',
        permission: K.SUPER_ADMIN
    },

    // 2. 其他操作 (配置、签名、删图、列表) -> 📸 只要有发图权限即可
    // 覆盖路径: /config, /signature, /delete, /resources
    {
        path: '/api/cloudinary',
        method: 'ALL',
        permission: K.BLOG_INTERACT
    },

    // ============================================================
    // Level 5: 复杂用户管理 (正则匹配优先)
    // ============================================================
    // 1. 修改权限 (PUT /api/users/:id/permissions) -> 🔒 只有超管
    {
        regex: /^\/api\/users\/.*\/permissions$/,
        method: 'PUT',
        permission: K.SUPER_ADMIN
    },

    // 2. 修改角色 (PUT /api/users/:id/role) -> 🔒 只有超管
    {
        regex: /^\/api\/users\/.*\/role$/,
        method: 'PUT',
        permission: K.SUPER_ADMIN
    },

    // 3. VIP 管理 -> 需用户管理权限 (USER:MANAGE)
    {
        path: '/api/users/grant-vip',
        method: 'PUT',
        permission: K.USER_MANAGE
    },
    {
        path: '/api/users/revoke-vip',
        method: 'PUT',
        permission: K.USER_MANAGE
    },

    // 4. 用户模块兜底规则 (Profile, List, UpdateSelf) -> 🟡 仅需登录
    // 适用于 /api/users, /api/users/:id 等
    {
        path: '/api/users',
        method: 'ALL',
        permission: null
    },

    // ============================================================
    // Level 6: 私有功能模块 (全路径封锁)
    // ============================================================
    // 待办事项
    {
        path: '/api/todo',
        method: 'ALL',
        permission: K.TODO_USE
    },

    // 运动 & 健康 (含生理期)
    {
        path: '/api/fitness',
        method: 'ALL',
        permission: K.FITNESS_USE
    },
    {
        path: '/api/period',
        method: 'ALL',
        permission: K.PERIOD_USE
    }, // 🔥 新模块
    {
        path: '/api/footprints',
        method: 'ALL',
        permission: K.FOOTPRINT_USE
    },

    // AI / Chat
    {
        path: '/api/ai',
        method: 'ALL',
        permission: K.BRAIN_USE
    },
    {
        path: '/api/chat',
        method: 'ALL',
        permission: K.BRAIN_USE
    },

    // 外部资源
    {
        path: '/api/external',
        method: 'ALL',
        permission: K.EXTERNAL_RESOURCES_USE
    },

    // ============================================================
    // Level 7: 系统核心管理 (High Risk)
    // ============================================================
    // 1. 管理员操作: 查看列表(GET) 和 审批(PUT) -> 🔒 必须超管
    // 注意：PUT 这里用了正则，匹配 /api/permission-requests/:id/approve 等
    {
        path: '/api/permission-requests',
        method: 'GET',
        permission: K.SUPER_ADMIN
    },
    {
        regex: /^\/api\/permission-requests\/.*$/,
        method: 'PUT',
        permission: K.SUPER_ADMIN
    },

    // 2. 用户操作: 提交申请(POST) -> 🟡 仅需登录
    // 必须放在上面两条之后，或者精确指定 method: 'POST'
    {
        path: '/api/permission-requests',
        method: 'POST',
        permission: null
    },

    // RBAC 核心数据
    {
        path: '/api/permissions',
        method: 'ALL',
        permission: K.SUPER_ADMIN
    },
    {
        path: '/api/roles',
        method: 'ALL',
        permission: K.SUPER_ADMIN
    },

    // 系统运维
    {
        path: '/api/audit',
        method: 'ALL',
        permission: K.SYSTEM_LOGS_USE
    },
    {
        path: '/api/backup',
        method: 'ALL',
        permission: K.SYSTEM_LOGS_USE
    },
    {
        path: '/api/cron',
        method: 'ALL',
        permission: K.SYSTEM_LOGS_USE
    },
];

module.exports = ROUTE_MAP;