import { connect } from 'mongoose';
import { findOne } from '../models/User'; // ⚠️ 注意根据你的实际路径调整

// 获取命令行参数
// 用法: node scripts/bindPhone.js <email> <phone>
const args = process.argv.slice(2);
const targetEmail = args[0];
const targetPhone = args[1];

// 国际电话正则 (保持与 API 一致)
const PHONE_REGEX = /^\+?[0-9]{7,15}$/;

const bindPhone = async () => {
  if (!targetEmail || !targetPhone) {
    console.error('❌ 参数错误: 请提供邮箱和手机号');
    console.log('👉 用法示例: node scripts/bindPhone.js user@example.com +8613800000000');
    process.exit(1);
  }

  try {
    // 1. 连接数据库
    console.log('🔄 正在连接数据库...');
    await connect(process.env.MONGO_URI);
    console.log('✅ 数据库连接成功');

    // 2. 格式校验
    const cleanPhone = targetPhone.trim();
    if (!PHONE_REGEX.test(cleanPhone)) {
      console.error(`❌ 手机号格式不正确: ${cleanPhone}`);
      console.log('💡 提示: 请使用 E.164 格式，例如 +8613800000000');
      process.exit(1);
    }

    // 3. 查找目标用户
    const user = await findOne({ email: targetEmail });
    if (!user) {
      console.error(`❌ 未找到用户: ${targetEmail}`);
      process.exit(1);
    }
    console.log(`👤 找到用户: ${user.displayName} (ID: ${user.id})`);
    console.log(`   当前手机号: ${user.phone || '未绑定'}`);

    // 4. 冲突检测 (检查该手机号是否已被其他人绑定)
    const phoneOwner = await findOne({ phone: cleanPhone });
    if (phoneOwner) {
      // 如果查到的人不是当前用户，说明撞车了
      if (phoneOwner.id !== user.id) {
        console.error(`❌ 操作失败: 手机号 ${cleanPhone} 已被用户 [${phoneOwner.email}] 占用`);
        process.exit(1);
      } else {
        console.log('⚠️  提示: 该用户已经绑定了这个手机号，无需修改');
        process.exit(0);
      }
    }

    // 5. 执行更新
    user.phone = cleanPhone;
    await user.save();

    console.log('========================================');
    console.log(`🎉 成功绑定手机号!`);
    console.log(`📧 用户: ${user.email}`);
    console.log(`📱 手机: ${user.phone}`);
    console.log('========================================');

    process.exit(0);
  } catch (err) {
    console.error('❌ 系统错误:', err);
    process.exit(1);
  }
};

bindPhone();
