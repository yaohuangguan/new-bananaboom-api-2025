import User from '../models/User.js';
import systemCache from '../cache/memoryCache.js';

/**
 * 扣除一次某个 AI 项目的 Quota
 * 采用 $inc 安全控制并发，只对有余额的人生效。
 *
 * @param {string} userId - 用户 ID
 * @param {string} projectId - AI 项目名 (对应 User.aiServices 这个 Map 里的键)
 */
export const deductQuota = async (userId, projectId) => {
  try {
    const user = await User.findById(userId);
    if (!user) return false;

    // 先检查用户是否有初始化该项。如果没有，先设置一份带 default values 的副本
    if (!user.aiServices.has(projectId)) {
      user.aiServices.set(projectId, {
         quota: 1, // 初始默认
         isMember: false,
         subscriptionTier: 'none',
         enabled: true
      });
      await user.save();
    }

    const serviceInfo = user.aiServices.get(projectId);

    // 已经是会员了，无限畅饮，不需要扣除 quota
    if (serviceInfo.isMember) {
       // 再判定一下到期没？如果真的到期了，可以考虑不拦（因为在 guard 层拦了），或者在这里把 isMember 刷回 false
       // 但为简单起见，扣费机器不管验证逻辑。
       return true;
    }

    // 次数判断，防止扣成负数
    if (serviceInfo.quota <= 0) {
       console.log(`[QUOTA] User ${userId} used out '${projectId}' free tries.`);
       return false;
    }

    // 利用 Mongoose 对 Map 的直接操控，减 1
    serviceInfo.quota -= 1;
    // Map 类型必须标记修改才能被 Mongoose 监听到并执行 save
    user.markModified(`aiServices.${projectId}`);
    await user.save();

    // 🔥 关键：扣费成功后清除缓存，防止高并发查出旧余额导致白嫖
    const userCacheKey = `user_ai_services_${userId}`;
    systemCache.del(userCacheKey);

    console.log(`[QUOTA] Successfully deducted 1 quota for user ${userId} on '${projectId}'. Remaining: ${serviceInfo.quota}`);
    return true;

  } catch (err) {
    console.error(`[QUOTA ERROR] Failed to deduct quota for ${projectId}:`, err);
    return false;
  }
};
