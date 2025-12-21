const PERM_KEYS = {
  // ==========================================
  // 1. 用户基础 (User Basics)
  // ==========================================
  USER_UPDATE: 'USER:UPDATE_SELF', // 修改个人资料
  BLOG_INTERACT: 'BLOG:INTERACT', // 博客点赞/评论
  // 📝 博客权限粒度
  BLOG_MANAGE: 'BLOG:MANAGE',
  
  // ==========================================
  // 2. 私域/门票 (Private Domain)
  // ==========================================
  PRIVATE_ACCESS: 'PRIVATE_DOMAIN:ACCESS', // 进入私域的门票
  PRIVATE_POST_USE: 'PRIVATE_POST:USE', // 发私密贴
  PRIVATE_POST_READ: 'PRIVATE_POST:READ', // 读私密贴

  // ==========================================
  // 3. 核心功能模块 (Modules)
  // ==========================================
  // --- 第二大脑 (AI) ---
  BRAIN_USE: 'BRAIN:USE',

  // --- 胶囊相册 ---
  CAPSULE_USE: 'CAPSULE:USE',

  // --- 待办事项 ---
  TODO_USE: 'TODO:USE',

  // --- 休闲空间 (留言板等) ---
  LEISURE_USE: 'LEISURE:USE',


  // --- 外部资源 ---
  EXTERNAL_RESOURCES_USE: 'EXTERNAL:USE',

  // --- 足迹 ---
  FOOTPRINT_USE: 'FOOTPRINT:USE',

  // ==========================================
  // 4. 运动与健康 (Health & Fitness)
  // ==========================================
  FITNESS_USE: 'FITNESS:USE', // 记录自己的运动/生理期
  FITNESS_READ_ALL: 'FITNESS:READ_ALL', // 看全员大盘 (上帝视角)
  FITNESS_EDIT_ALL: 'FITNESS:EDIT_ALL', // 帮别人修改数据

  PERIOD_USE: 'PERIOD:USE', // 生理期记录 (新加的)
  MENU_USE:'MENU:USE',

  // ==========================================
  // 5. 系统管理 (System Admin)
  // ==========================================
  SYSTEM_LOGS_USE: 'SYSTEM_LOGS:USE', // 查看审计日志/备份

  IMAGE_RESOURCES_USE: 'IMAGE_RESOURCES:USE',
  // --- 超级管理员通配符 ---
  SUPER_ADMIN: '*'
};

module.exports = PERM_KEYS;