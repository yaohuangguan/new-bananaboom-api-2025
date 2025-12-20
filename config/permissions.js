// config/permissions.js
const K = require('./constants'); // 引入常量

const PERMISSIONS = {
  // User
  user: [
    K.USER_UPDATE,
    K.BLOG_INTERACT
  ],

  // Bot
  bot: [
    K.BRAIN_USE
  ],

  // Admin
  admin: [
    K.PRIVATE_ACCESS,
    K.USER_UPDATE,
    K.BLOG_INTERACT,
    K.BRAIN_USE,
    K.CAPSULE_USE,
    K.LEISURE_READ,
    K.FITNESS_USE,
    K.FITNESS_READ_ALL, // 看大盘,
    K.EXTERNAL_RESOURCES_USE
  ],

  // Super Admin
  super_admin: [
    '*'
  ]
};

module.exports = PERMISSIONS;