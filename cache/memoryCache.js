// utils/cache.js
import NodeCache from 'node-cache';

// 创建一个缓存实例
// stdTTL: 默认过期时间 (秒)，这里设为 7200秒 = 2小时
// checkperiod: 检查过期的频率 (秒)
const systemCache = new NodeCache({ stdTTL: 7200, checkperiod: 600 });

export default systemCache;
