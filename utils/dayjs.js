/**
 * @module utils/time
 * @description 统一时间处理工具
 */
import dayjs from 'dayjs';

// 格式常量：精确到分钟
const FORMAT_MINUTE = 'YYYY-MM-DD HH:mm';

/**
 * 获取当前时间，精确到分钟
 * @returns {String} e.g., "2025-12-21 20:30"
 */
const getCurrentTime = () => {
  return dayjs().format(FORMAT_MINUTE);
};

export {
  getCurrentTime,
  dayjs // 导出原始实例以备不时之需
};
