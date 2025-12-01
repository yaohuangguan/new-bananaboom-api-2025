// 这是一个“内存版”的 Redis 模拟器
// 专门为了在 Cloud Run 上省钱而设计
// 它把数据存在内存里，而不是连接外部数据库

const memoryStore = new Map();

module.exports = {
  // 模拟 get
  get: (key) => {
    return new Promise((resolve) => {
      const val = memoryStore.get(key);
      // console.log(`[MemoryRedis] GET ${key} = ${val}`);
      resolve(val || null);
    });
  },

  // 模拟 set
  set: (key, value) => {
    return new Promise((resolve) => {
      // console.log(`[MemoryRedis] SET ${key}`);
      memoryStore.set(key, value);
      resolve('OK');
    });
  },

  // 模拟 del
  del: (key) => {
    return new Promise((resolve) => {
      memoryStore.delete(key);
      resolve(1);
    });
  },

  // 模拟 expire (这里我们不做实际过期，简化处理)
  expire: () => Promise.resolve(1),
  
  // 兼容旧代码的接口
  createClient: () => module.exports,
  on: () => {}, 
  connect: () => Promise.resolve()
};