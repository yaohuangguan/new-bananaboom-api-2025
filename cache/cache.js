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
  connect: () => Promise.resolve()
};