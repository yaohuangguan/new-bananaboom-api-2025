// update_bark.js
require("dotenv").config(); // 加载 .env 里的数据库连接字符串
const mongoose = require("mongoose");
const readline = require("readline");

// 引入你的 User 模型 (确保路径对)
const User = require("../models/User");

// 创建命令行交互接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 辅助函数：提问
const askQuestion = (query) => {
  return new Promise((resolve) => rl.question(query, resolve));
};

async function main() {
  try {
    // 1. 连接数据库
    console.log("🔌 正在连接 MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ 数据库已连接");

    // 2. 交互式输入
    const email = await askQuestion("请输入要更新的用户邮箱 (Email): ");
    
    // 查找用户是否存在
    const user = await User.findOne({ email: email.trim() });
    if (!user) {
      console.error(`❌ 未找到邮箱为 ${email} 的用户！`);
      process.exit(1);
    }
    console.log(`👤 找到用户: ${user.displayName} (${user._id})`);

    const barkKey = await askQuestion("请输入 Bark 服务器地址 (例如 https://api.day.app/你的Key/): ");
    const cleanUrl = barkKey.trim();

    if (!cleanUrl.startsWith("http")) {
      console.error("❌ Bark URL 格式看起来不对，必须以 http 或 https 开头");
      process.exit(1);
    }

    // 3. 更新字段
    // 因为 barkUrl 是 select: false，我们使用 updateOne 直接操作数据库层面，这样最稳
    const result = await User.updateOne(
      { _id: user._id },
      { $set: { barkUrl: cleanUrl } }
    );

    if (result.modifiedCount > 0) {
      console.log("🎉 更新成功！");
      console.log(`✅ 用户 [${user.displayName}] 的 Bark URL 已保存。`);
    } else {
      console.log("⚠️ 数据未变动 (可能你输入的 URL 和原来的一样)");
    }

    // 4. (可选) 验证一下，显式查出来看看
    const verifyUser = await User.findById(user._id).select('+barkUrl');
    console.log("🔍 验证数据库存储值:", verifyUser.barkUrl);

  } catch (err) {
    console.error("❌ 发生错误:", err);
  } finally {
    // 关闭连接并退出
    await mongoose.disconnect();
    rl.close();
    process.exit(0);
  }
}

main();