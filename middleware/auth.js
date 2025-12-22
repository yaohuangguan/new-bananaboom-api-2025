/**
 * @module middleware/auth
 * @description 【Soft Auth 模式】
 * 认证中间件：仅负责解析身份，不负责拦截请求。
 * * 逻辑策略：
 * 1. 尝试解析 Token。
 * 2. 如果成功 -> 挂载 req.user -> next()
 * 3. 如果失败 (无Token/过期/失效) -> 标记 req.user = null (游客) -> next()
 * * ⚠️ 注意：安全拦截 (401) 的工作完全移交给后续的 GlobalGuard 处理。
 */

import jwt from 'jsonwebtoken';
import { get } from '../cache/session.js'; // MongoDB/Redis Session 助手
import permissionService from '../services/permissionService.js'; // 权限服务
const SECRET = process.env.SECRET_JWT || 'secret';

export default async function (req, res, next) {
  // ============================================================
  // 1. 提取 Token
  // ============================================================
  // 支持自定义 Header x-auth-token 或标准 Authorization Bearer 格式
  let token = req.header('x-auth-token');
  const authHeader = req.header('Authorization');

  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // ============================================================
  // 2. 无 Token 情况：直接视为游客
  // ============================================================
  if (!token) {
    req.user = null; // 明确标记为游客
    return next();   // 🔥 放行 (让 GlobalGuard 决定是否拦截)
  }

  try {
    // ============================================================
    // 3. 安全校验：JWT 格式与签名
    // ============================================================
    // 如果 verify 失败 (过期/篡改)，会抛出错误进入 catch
    jwt.verify(token, SECRET);

    // ============================================================
    // 4. 状态校验：Session 白名单
    // ============================================================
    // 必须带上 "auth:" 前缀查询
    const userIdInSession = await get(`auth:${token}`);

    // 🔥 Soft Fail: 如果 Session 不存在 (已登出/被踢/Redis过期)
    // 不要报错，而是降级为游客，防止登录接口死锁
    if (!userIdInSession) {
      req.user = null;
      return next();
    }

    // ============================================================
    // 5. 数据补全：获取实时用户信息
    // ============================================================
    const liveUser = await permissionService.getLiveUserPayload(userIdInSession);

    // 🔥 Soft Fail: 如果用户物理删除了，降级为游客
    if (!liveUser) {
      req.user = null;
      return next();
    }

    // ============================================================
    // 6. 认证成功：挂载数据
    // ============================================================
    req.user = liveUser;

    // ID 兼容性处理 (确保 id 和 _id 都有)
    if (req.user._id && !req.user.id) req.user.id = req.user._id;
    if (req.user.id && !req.user._id) req.user._id = req.user.id;

    // 挂载原始 Token 供业务使用
    req.user.token = token;
    req.userId = req.user.id;

    next(); // ✅ 身份解析成功，进入下一关

  } catch (error) {
    // ============================================================
    // 7. 错误处理 (Soft Fail)
    // ============================================================
    // 无论是 TokenExpiredError 还是 JsonWebTokenError
    // 只要解析失败，统统视为游客，不中断请求
    
    // 开发环境下打印日志方便调试，生产环境可关闭
    if (process.env.NODE_ENV === 'development') {
      // 只有非过期类的未知错误才打印，避免刷屏
      if (error.name !== 'TokenExpiredError') {
        console.warn('[Auth] Token parse failed (Access downgraded to Guest):', error.message);
      }
    }

    req.user = null; // 标记为游客
    next();          // 🔥 放行
  }
}