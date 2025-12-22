import K from './permissionKeys.js';

/**
 * 🛡️ 优化后的全局路由权限守卫配置
 * 改进点：
 * 1. 精确的 ObjectId 正则匹配
 * 2. 明确的权限分层
 * 3. 配合 GlobalGuard 的实时权限 Key 校验
 */
const ROUTE_MAP = [
  // ============================================================
  // Level 1: 纯公开基础设施 (Public)
  // ============================================================
  { path: '/health', method: 'GET', public: true },

  // ============================================================
  // Level 2: 登录与注册入口 (Auth Entry)
  // ============================================================
  { path: '/api/auth', method: 'ALL', public: true },
  { path: '/api/users/signin', method: 'POST', public: true },
  { path: '/api/users/reset-by-secret', method: 'POST', public: true },
  { path: '/api/users', method: 'POST', public: true }, // 注册

  // ============================================================
  // Level 3: CMS 内容展示 (读公开 / 写鉴权)
  // ============================================================
  { path: '/api/resumes', method: 'GET', public: true },
  { path: '/api/resumes', method: 'ALL', permission: K.SUPER_ADMIN },

  { path: '/api/projects', method: 'GET', public: true },
  { path: '/api/projects', method: 'ALL', permission: K.SUPER_ADMIN },

  { path: '/api/homepage', method: 'GET', public: true },
  { path: '/api/homepage', method: 'ALL', permission: K.SUPER_ADMIN },

  { path: '/api/menu', method: 'GET', public: true },
  { path: '/api/menu', method: 'ALL', permission: K.MENU_USE },

  { path: '/api/posts/private/posts', method: 'GET', permission: K.PRIVATE_POST_READ },
  { path: '/api/posts', method: 'GET', public: true },

  // 精确匹配 /api/posts/6583d987... 这种格式，防止被前缀匹配截断
  { regex: /^\/api\/posts\/[a-f\d]{24}$/, method: 'GET', public: true },

  // =================================================================
  // Level 4: 互动区域 (Likes & Comments)
  // =================================================================
  { regex: /^\/api\/posts\/likes\/[a-f\d]{24}$/, method: 'GET', public: true },
  { regex: /^\/api\/posts\/likes\/[a-f\d]{24}\/add$/, method: 'POST', permission: null },
  { regex: /^\/api\/posts\/likes\/[a-f\d]{24}\/remove$/, method: 'POST', permission: null },

  // =================================================================
  // Level 5: 管理区域 (Blog Management)
  // =================================================================
  { path: '/api/posts', method: 'POST', permission: K.BLOG_MANAGE },
  { regex: /^\/api\/posts\/[a-f\d]{24}$/, method: 'PUT', permission: K.BLOG_MANAGE },
  { regex: /^\/api\/posts\/[a-f\d]{24}$/, method: 'DELETE', permission: K.BLOG_MANAGE },

  { path: '/api/comments', method: 'GET', public: true },
  { path: '/api/comments', method: 'ALL', permission: K.BLOG_INTERACT },

  // ============================================================
  // Level 6: Cloudinary 图片服务
  // ============================================================
  { path: '/api/cloudinary/usage', method: 'GET', permission: K.SUPER_ADMIN },
  { path: '/api/cloudinary', method: 'ALL', permission: K.BLOG_INTERACT },

  // ============================================================
  // Level 7: 复杂用户管理 (正则优先级最高)
  // ============================================================

  // 🔥 1. 修改权限 (PUT /api/users/:id/permissions) -> 🔒 只有超管
  {
    regex: /^\/api\/users\/[a-f\d]{24}\/permissions$/,
    method: 'PUT',
    permission: K.SUPER_ADMIN
  },

  // 🔥 2. 修改角色 (PUT /api/users/:id/role) -> 🔒 只有超管
  {
    regex: /^\/api\/users\/[a-f\d]{24}\/role$/,
    method: 'PUT',
    permission: K.SUPER_ADMIN
  },

  { path: '/api/users/grant-vip', method: 'PUT', permission: K.USER_MANAGE },
  { path: '/api/users/revoke-vip', method: 'PUT', permission: K.USER_MANAGE },

  // 🔥 3. 踢人下线 (DELETE /api/users/:id/sessions) -> 🔒 管理员以上
  {
    regex: /^\/api\/users\/[a-f\d]{24}\/sessions$/,
    method: 'DELETE',
    permission: K.SUPER_ADMIN
  },

  // 用户模块兜底 (必须放在上面三个正则之后)
  { path: '/api/users', method: 'ALL', permission: null },

  // ============================================================
  // Level 8: 私有功能模块
  // ============================================================
  { path: '/api/todo', method: 'ALL', permission: K.TODO_USE },
  { path: '/api/fitness', method: 'ALL', permission: K.FITNESS_USE },
  { path: '/api/period', method: 'ALL', permission: K.PERIOD_USE },
  { path: '/api/footprints', method: 'ALL', permission: K.FOOTPRINT_USE },
  { path: '/api/ai', method: 'ALL', permission: K.BRAIN_USE },
  { path: '/api/chat', method: 'ALL', permission: K.BRAIN_USE },

  // ============================================================
  // Level 9: 系统核心管理 (High Risk)
  // ============================================================
  { path: '/api/permission-requests', method: 'GET', permission: K.SUPER_ADMIN },
  { regex: /^\/api\/permission-requests\/[a-f\d]{24}\/.*$/, method: 'PUT', permission: K.SUPER_ADMIN },
  { path: '/api/permission-requests', method: 'POST', permission: null },
  { path: '/api/permissions', method: 'GET', permission: null },
  { path: '/api/permissions', method: 'ALL', permission: K.SUPER_ADMIN },
  { path: '/api/roles', method: 'GET', permission: null },
  { path: '/api/roles', method: 'ALL', permission: K.SUPER_ADMIN },
  { path: '/api/audit', method: 'ALL', permission: K.SYSTEM_LOGS_USE },
  { path: '/api/backup', method: 'ALL', permission: K.SYSTEM_LOGS_USE }
];

const sortedMap = ROUTE_MAP.sort((a, b) => {
  // 1. 🛡️ 防御性检查：确保 a 和 b 至少有一个匹配依据
  const pathA = a.path || '';
  const pathB = b.path || '';

  // 2. 正则规则优先级提升
  // 如果 a 有正则而 b 没有，a 排前面
  if (a.regex && !b.regex) return -1;
  if (!a.regex && b.regex) return 1;

  // 3. 路径长度降序排列
  // 这样 /api/posts/private (length 18) 会排在 /api/posts (length 10) 前面
  return pathB.length - pathA.length;
});

export default sortedMap;
