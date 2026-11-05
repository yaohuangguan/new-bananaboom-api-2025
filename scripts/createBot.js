import { connect } from 'mongoose';
import { genSalt, hash } from 'bcryptjs'; // 确保安装了 bcryptjs
import User, { findOne } from '../models/User'; // 确保路径正确

const createBot = async () => {
  try {
    // 1. 连接数据库
    console.log('🔌 正在连接数据库...');
    await connect(process.env.MONGO_URI);
    console.log('✅ 数据库连接成功');

    const BOT_EMAIL = 'ai_brain@system.bot'; // 机器人的专用邮箱

    // 2. 检查机器人是否已存在
    const botUser = await findOne({ email: BOT_EMAIL });

    if (botUser) {
      console.log(`⚠️ 机器人用户已存在!`);
      console.log(`🆔 Robot ID: ${botUser._id}`);
      console.log(`🎭 Role: ${botUser.role}`);
      process.exit(0);
    }

    console.log('🤖 正在创建新的 AI 机器人用户...');

    // 3. 准备数据
    // 生成一个随机长密码，确保没人能登录这个账号
    const randomPassword = 'BOT_PASS_' + Math.random().toString(36).slice(-8) + Date.now();
    const salt = await genSalt(10);
    const hashedPassword = await hash(randomPassword, salt);

    // 4. 创建实例
    const newBot = new User({
      displayName: 'Second Brain AI', // 前端显示的昵称
      email: BOT_EMAIL,
      password: hashedPassword,
      date: new Date().toISOString(),
      role: 'bot', // 🔥 关键：设置角色为 bot
      photoURL: 'https://cdn-icons-png.flaticon.com/512/4712/4712027.png', // 机器人头像
      height: 175, // 占位数据
      fitnessGoal: 'maintain'
    });

    // 5. 保存
    await newBot.save();

    console.log('🎉 机器人创建成功！');
    console.log('========================================');
    console.log(`🆔 机器人真实 ID (请复制这个): ${newBot._id}`);
    console.log('========================================');

    process.exit(0);
  } catch (err) {
    console.error('❌ 创建失败:', err);
    process.exit(1);
  }
};

createBot();
