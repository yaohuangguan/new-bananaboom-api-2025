// migrate_todos.js
require("dotenv").config();
const mongoose = require("mongoose");
const readline = require("readline");

// 引入模型
const User = require("../models/User");
const Todo = require("../models/Todo");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => {
  return new Promise((resolve) => rl.question(query, resolve));
};

async function main() {
  try {
    console.log("🔌 正在连接 MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ 数据库已连接");

    // 1. 统计有多少旧数据
    const orphanCount = await Todo.countDocuments({
      $or: [{ user: { $exists: false } }, { user: null }]
    });

    if (orphanCount === 0) {
      console.log("🎉 恭喜！你的数据库很干净，没有无主任务。无需迁移。");
      process.exit(0);
    }

    console.log(`⚠️  发现 [${orphanCount}] 条无主任务 (旧数据)。`);
    console.log("🚀 准备开始迁移...");

    // 2. 询问新主人是谁
    const email = await askQuestion("请输入要接收这些数据的用户邮箱 (Email): ");
    
    const targetUser = await User.findOne({ email: email.trim() });
    if (!targetUser) {
      console.error(`❌ 未找到邮箱为 ${email} 的用户！`);
      process.exit(1);
    }

    console.log(`👤 目标用户: ${targetUser.displayName} (${targetUser._id})`);
    
    const confirm = await askQuestion(`❓ 确定要把这 ${orphanCount} 条任务全部划拨给 ${targetUser.displayName} 吗？(y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("🚫 操作已取消。");
      process.exit(0);
    }

    // 3. 执行批量更新
    const result = await Todo.updateMany(
      { $or: [{ user: { $exists: false } }, { user: null }] },
      { $set: { user: targetUser._id } }
    );

    console.log("------------------------------------------------");
    console.log(`🎉 迁移成功！共更新了 ${result.modifiedCount} 条数据。`);
    console.log(`✅ 现在所有旧任务都属于 [${targetUser.displayName}] 了。`);
    console.log("💡 前端刷新页面，应该就能正常显示且不会报错了。");

  } catch (err) {
    console.error("❌ 发生错误:", err);
  } finally {
    await mongoose.disconnect();
    rl.close();
    process.exit(0);
  }
}

main();