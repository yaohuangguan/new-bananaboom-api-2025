// 使用 MongoDB 替代 Redis 实现持久化缓存
const Session = require("../models/Session");

module.exports = {
  // 获取 Token
  get: async (key) => {
    try {
      const session = await Session.findOne({ key });
      return session ? session.value : null;
    } catch (err) {
      console.error("Cache GET error:", err);
      return null;
    }
  },

  // 存储 Token (支持 upsert: 如果存在就更新，不存在就创建)
  set: async (key, value) => {
    try {
      // 这里的 expire 参数我们在 Model 里定义了默认值，所以这里可以忽略
      await Session.findOneAndUpdate(
        { key }, 
        { key, value, createdAt: new Date() }, // 更新时间以重置过期倒计时
        { upsert: true, new: true }
      );
      return "OK";
    } catch (err) {
      console.error("Cache SET error:", err);
    }
  },

  // 删除 Token (登出)
  del: async (key) => {
    try {
      await Session.findOneAndDelete({ key });
      return 1;
    } catch (err) {
      console.error("Cache DEL error:", err);
      return 0;
    }
  },
  
  // 兼容性接口 (防止报错)
  expire: () => Promise.resolve(1),
  createClient: () => module.exports,
  on: () => {},
  connect: () => Promise.resolve(),
  /**
   * 🔥 包装方法：静默更新用户所有在线 Session 的信息
   * @param {String} userId - 目标用户ID
   * @param {Object} newData - 最新的用户信息快照 (Payload)
   * @returns {Promise<Number>} - 返回更新的文章数量
   */
  updateUserSession: async (userId, newData) => {
    try {
      // 1. 确保数据是字符串格式
      const valueString = JSON.stringify(newData);

      // 2. 核心逻辑：使用 $regex 模糊匹配 value 字段中包含的 userId
      // 因为我们存的是 JSON 字符串，里面一定包含 "id":"xxxx" 或 "userId":"xxxx"
      const result = await Session.updateMany(
        { value: { $regex: userId } }, 
        { 
          $set: { 
            value: valueString,
            createdAt: new Date() // 可选：更新后顺便重置过期时间
          } 
        }
      );

      console.log(`♻️ [Session Helper] 已同步更新用户 ${userId} 的 ${result.modifiedCount} 个会话`);
      return result.modifiedCount;
    } catch (err) {
      console.error("❌ [Session Helper] 更新用户 Session 失败:", err);
      return 0;
    }
  },
};