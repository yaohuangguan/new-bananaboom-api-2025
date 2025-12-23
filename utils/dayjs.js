/**
 * @module utils/dayjs
 * @description 统一时间处理工具
 */
import dayjs from 'dayjs';
// 引入 UTC 插件，虽然这里我们直接返回 Date 对象，但引入防身
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 获取当前时间
 * 🔥 核心修改：直接返回原生 Date 对象
 * MongoDB 会自动将其存储为 ISODate("2025-12-23T02:02:00Z")
 * 前端拿到这个格式后，会自动根据用户手机的时区（+8），显示为 10:02
 * @returns {Date}
 */
const getCurrentTime = () => {
  return new Date(); 
};

export {
  getCurrentTime,
  dayjs
};