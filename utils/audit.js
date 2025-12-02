const AuditLog = require("../models/AuditLog");
const axios = require("axios");

// 这里需要引入 io 实例。
// 由于 io 是在 index.js 初始化并传给 socket.js 的，
// 最简单的办法是把这个工具函数做成一个类，或者在 index.js 里把 io 挂载到 global (虽然不优雅但实用)
// 或者，我们在这个文件里不直接引用 io，而是让调用者传进来，或者使用事件总线。

// 为了简单且解耦，我们建议：在 index.js 里把 io 挂载到 app 上： app.set('io', io)
// 然后在路由里通过 req.app.get('io') 获取。

// 但为了在任意地方都能用，我们这里先只负责【存库】和【外部推送】，Socket 推送在路由层做。

/**
 * 记录操作日志
 * @param {Object} params
 * @param {String} params.operatorId - 操作人ID
 * @param {String} params.action - 动作
 * @param {String} params.target - 目标
 * @param {Object} params.details - 详情
 * @param {String} params.ip - IP地址
 * @param {Object} io - Socket.io 实例 (可选，用于实时通知)
 */
const logOperation = async ({ operatorId, action, target, details, ip, io }) => {
  try {
    // 1. 存入数据库
    const newLog = new AuditLog({
      operator: operatorId,
      action,
      target,
      details,
      ip
    });
    const savedLog = await newLog.save();

    // 2. 填充用户信息 (为了推送时能显示是谁)
    await savedLog.populate("operator", "displayName");

    const message = `[${savedLog.operator.displayName}] 执行了 [${action}] - ${target}`;
    console.log("📝 Audit:", message);

    // 3. Socket.io 实时推送 (如果你在后台，网页会立马弹窗)
    if (io) {
      // 发送给所有连接的管理员 (或者所有人)
      io.emit("NEW_OPERATION_LOG", {
        message,
        log: savedLog
      });
    }

    // 4. 手机推送 (可选：使用 Bark / Server酱 / 钉钉机器人)
    // 这是一个发 HTTP 请求给 Bark (iOS) 的例子
    // 你的 Bark 链接: https://api.day.app/你的Key/推送内容
    const BARK_URL = process.env.BARK_URL; 
    if (BARK_URL) {
       // 异步发送，不阻塞主流程
       axios.get(`${BARK_URL}/${encodeURIComponent("操作提醒")}/${encodeURIComponent(message)}`)
         .catch(e => console.error("Push failed", e.message));
    }

  } catch (error) {
    console.error("Log operation failed:", error);
  }
};

module.exports = logOperation;