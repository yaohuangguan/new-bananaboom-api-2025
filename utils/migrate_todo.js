// migrate_periods.js
require("dotenv").config();
const mongoose = require("mongoose");
const readline = require("readline");

// 引入模型
const User = require("../models/User");
const Period = require("../models/Period");

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

    // 1. 查找所有没有绑定用户的 Period
    // 注意：因为刚才 Schema 加了 user 字段但数据库里还没有，所以查 user不存在的记录
    const query = { user: { $exists: false } };
    const orphanCount = await Period.countDocuments(query);

    if (orphanCount === 0) {
      console.log("🎉 所有生理期记录都有主人了，无需迁移。");
      process.exit(0);
    }

    console.log(`⚠️  发现 [${orphanCount}] 条未绑定的生理期记录。`);
    console.log("💡 因为目前只有老婆用过，我们将全部划拨给指定账户。");

    // 2. 获取老婆账户
    const email = await askQuestion("👩 请输入老婆账户的邮箱 (Email): ");
    const targetUser = await User.findOne({ email: email.trim() });
    
    if (!targetUser) {
      console.error(`❌ 未找到邮箱为 ${email} 的用户！`);
      process.exit(1);
    }

    console.log(`✅ 锁定目标: ${targetUser.displayName} (${targetUser._id})`);
    
    const confirm = await askQuestion(`❓ 确定将这 ${orphanCount} 条记录全部过户给她吗？(y/n): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log("🚫 操作已取消");
      process.exit(0);
    }

    // 3. 执行更新
    const result = await Period.updateMany(
      query,
      { $set: { user: targetUser._id } }
    );

    console.log("------------------------------------------------");
    console.log(`🎉 迁移成功！共更新了 ${result.modifiedCount} 条数据。`);
    console.log(`✅ 现在这些数据归 [${targetUser.displayName}] 独有了。`);

  } catch (err) {
    console.error("❌ 发生错误:", err);
  } finally {
    await mongoose.disconnect();
    rl.close();
    process.exit(0);
  }
}

main();