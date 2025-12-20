require('dotenv').config(); // 读取 .env 里的数据库连接串
const mongoose = require('mongoose');
const User = require('../models/User'); // ⚠️ 注意：请确认你的 User 模型路径是否正确

const migrate = async () => {
  try {
    // 1. 连接数据库
    console.log("🔌 正在连接数据库...");
    await mongoose.connect(process.env.MONGO_URI); // 确保你的 .env 里有 MONGO_URI
    console.log("✅ 数据库连接成功");

    console.log("⏳ 开始迁移数据...");

    // 2. 迁移 VIP 用户 -> super_admin
    // updateMany: 批量更新所有符合条件的文档
    const vipResult = await User.updateMany(
      { vip: true }, // 条件：原本是 VIP
      { $set: { role: 'super_admin' } } // 操作：角色设为超级管理员
    );
    console.log(`🚀 已将 ${vipResult.modifiedCount} 个 VIP 用户升级为 Super Admin`);

    // 3. 迁移普通用户 -> user
    // 条件：role 字段不存在 (防止覆盖已经手动设置过的管理员)，并且不是 VIP
    const userResult = await User.updateMany(
      { role: { $exists: false }, vip: { $ne: true } }, 
      { $set: { role: 'user' } }
    );
    console.log(`👥 已将 ${userResult.modifiedCount} 个普通用户初始化为 User`);

    // 4. (可选) 如果你有特定的邮箱想设为 Admin (普通管理员)，可以在这里硬编码
    // const adminEmail = "your_admin_email@example.com";
    // await User.updateOne({ email: adminEmail }, { $set: { role: 'admin' } });
    // console.log(`🛡️ 已设置 ${adminEmail} 为 Admin`);

    console.log("🎉 数据迁移完成！");
    process.exit(0);

  } catch (err) {
    console.error("❌ 迁移失败:", err);
    process.exit(1);
  }
};

migrate();