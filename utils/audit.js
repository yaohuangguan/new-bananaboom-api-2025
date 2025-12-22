/**
 * @module utils/audit
 * @description 审计日志记录器 - 负责操作落库、控制台打印、Socket实时推送及第三方推送
 */
import AuditLog from '../models/AuditLog.js';
import fetch from './http.js';

/**
 * 记录操作日志并执行多端推送
 * @param {Object} params - 包含 operatorId, action, target, details, ip
 * @param {Object} io - Socket.io 实例 (从 req.app.get('socketio') 传入)
 */
const logOperation = async ({ operatorId, action, target, details, ip, io }) => {
  try {
    // 1. 数据入库
    // operatorId 对应 User Model 的 ObjectId
    const newLog = new AuditLog({
      operator: operatorId,
      action,
      target,
      details,
      ip
    });
    const savedLog = await newLog.save();

    // 2. ⚡ 核心修复：填充用户信息
    // 必须同时填充 displayName 和 name，确保后面拼接不为 undefined
    await savedLog.populate('operator', 'displayName name');

    // 3. 🛡️ 兼容性字段提取
    // 这里的逻辑与 permissionService.buildUserPayload 保持一致的“双保险”
    const op = savedLog.operator;
    let operatorName = 'System/Unknown';

    if (op) {
      // 这里的优先级逻辑：优先取展示名，没有就取用户名，最后兜底 ID
      operatorName = op.displayName || op.name || op._id.toString();
    }

    // 4. 构造统一消息文本
    const message = `[${operatorName}] 执行了 [${action}] - ${target}`;
    console.log('📝 Audit:', message);

    // 5. Socket.io 实时推送
    // 用于管理员后台页面的实时滚动日志
    if (io) {
      io.emit('NEW_OPERATION_LOG', {
        message,
        log: savedLog,
        timestamp: new Date()
      });
    }

    // 6. 外部推送 (例如 iOS Bark)
    // 异步执行，使用 catch 捕获错误，不干扰主线程响应速度
    const BARK_URL = process.env.BARK_URL;
    if (BARK_URL) {
      const pushTitle = encodeURIComponent('BananaBoom 安全提醒');
      const pushBody = encodeURIComponent(message);

      fetch
        .get(`${BARK_URL}/${pushTitle}/${pushBody}`)
        .catch((e) => console.error('⚠️ [Push] Bark 推送失败:', e.message));
    }

    return savedLog; // 返回存好的日志文档供后续可能的使用
  } catch (error) {
    // 审计日志报错不能中断业务流程，所以仅记录错误日志
    console.error('🔥 [Audit Error] 审计系统故障:', error);
  }
};

export default logOperation;
