require('dotenv').config(); // 确保能读取 .env 里的 MONGO_URI
const mongoose = require('mongoose');
const Role = require('../models/Role');
const Permission = require('../models/Permission');

// 引用你旧的配置文件
const OLD_PERMISSIONS_CONFIG = require('../config/permissions'); 
// 引用你的常量定义 (用于获取 key 的中文描述，如果没有可以先写死)
// const K = require('../config/permissionKeys'); 

const initRBAC = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("🔥 数据库连接成功，开始初始化 RBAC...");

    // ==========================================
    // 1. 提取所有唯一的权限 Key，并存入 Permission 表
    // ==========================================
    const allPermissionKeys = new Set();
    Object.values(OLD_PERMISSIONS_CONFIG).forEach(perms => {
      perms.forEach(p => allPermissionKeys.add(p));
    });

    console.log(`🔍 发现 ${allPermissionKeys.size} 个唯一权限...`);

    for (const key of allPermissionKeys) {
      // 简单起见，Name 和 Description 暂时用 Key 代替
      // 以后你可以去后台管理界面手动修改成中文
      await Permission.findOneAndUpdate(
        { key: key },
        { 
          key: key,
          name: key, // 暂用 key，你可以手动改成 "使用健身功能"
          description: `系统自动导入: ${key}`,
          category: 'AUTO_IMPORT' 
        },
        { upsert: true, new: true }
      );
    }
    console.log("✅ Permission 表初始化完成");

    // ==========================================
    // 2. 将角色配置存入 Role 表
    // ==========================================
    for (const [roleName, perms] of Object.entries(OLD_PERMISSIONS_CONFIG)) {
      await Role.findOneAndUpdate(
        { name: roleName },
        { 
          permissions: perms, // 这里的 perms 数组里存的是 key 字符串
          updatedAt: new Date()
        },
        { upsert: true, new: true }
      );
      console.log(`✅ Role [${roleName}] 同步完成`);
    }

    console.log("🎉 RBAC 初始化全部完成！");
    process.exit(0);
  } catch (err) {
    console.error("❌ 初始化失败:", err);
    process.exit(1);
  }
};

initRBAC();