// config/constants.js

const PERM_KEYS = {
    // --- 用户基础 ---
    USER_UPDATE: 'user:update_self',
    BLOG_INTERACT: 'blog:interact',
  
    // --- 私域门票 ---
    PRIVATE_ACCESS: 'private_domain:access',

    //私域日志
    PRIVATE_POST_USE:'private_post:use',
    PRIVATE_POST_READ:'private_post:read',
  
    // --- 第二大脑 ---
    BRAIN_USE: 'brain:use',
  
    // --- 胶囊相册 ---
    CAPSULE_USE: 'capsule:use',
  
    // --- 休闲空间 ---
    LEISURE_READ: 'leisure:read',
    LEISURE_MANAGE: 'leisure:manage', // 删帖等
  
    // --- 运动空间 ---
    FITNESS_USE: 'fitness:use',       // 自己打卡
    FITNESS_READ_ALL: 'fitness:read_all', // 看大盘 (Admin)
    FITNESS_EDIT_ALL: 'fitness:edit_all', // 帮别人打卡 (Super Admin/Admin)
  
    // --- 系统/日志 (最高机密) ---
    SYSTEM_LOGS: 'system:logs',
  };
  
  module.exports = PERM_KEYS;