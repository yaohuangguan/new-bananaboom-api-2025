/**
 * @module middleware/auth
 * @description 【Hybrid Soft Auth 模式】
 * 认证中间件：负责解析身份。
 * * * 逻辑策略：
 * 1. 无 Token -> 游客 -> next()
 * 2. Token 过期/伪造 -> 🔥 401 拒绝 (满足测试用例 strict check)
 * 3. Token 有效但无 Session (被踢/Redis过期) -> ⬇️ 降级为游客 -> next()
 * 4. Token 有效且有 Session -> ✅ 登录用户 -> next()
 * * * ⚠️ 注意：
 * - 只有 Token 本身的合法性（过期/签名）会触发 401。
 * - 权限不足或未登录的拦截工作，仍建议交给 GlobalGuard。
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
    return next();   // ➡️ 放行 (交给 GlobalGuard 决定是否拦截)
  }

  try {
    // ============================================================
    // 3. 安全校验：JWT 格式与签名 (Strict Check)
    // ============================================================
    // 🔥 关键点：jwt.verify 如果失败（过期或签名错误），会直接 throw Error
    // 我们必须 catch 住这个错误并返回 401，而不是降级为游客
    jwt.verify(token, SECRET);

    // ============================================================
    // 4. 状态校验：Session 白名单 (Soft Check)
    // ============================================================
    // 必须带上 "auth:" 前缀查询 Redis/DB
    const userIdInSession = await get(`auth:${token}`);

    // 🔥 Soft Fail: 如果 Token 签名对，但 Session 没了 (已登出/Redis过期)
    // 这里选择降级为游客，而不是报错 401。
    // 场景：用户 Token 还在有效期，但服务器重启了 Redis 清空。
    // 策略：让他当游客访问首页，不要直接弹红框报错。
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

    // ID 兼容性处理 (确保 id 和 _id 都有，方便业务层调用)
    if (req.user._id && !req.user.id) req.user.id = req.user._id;
    if (req.user.id && !req.user._id) req.user._id = req.user.id;

    // 挂载原始 Token 供业务使用 (如注销接口需要用到)
    req.user.token = token;
    req.userId = req.user.id;

    next(); // ✅ 身份解析成功，进入下一关

  } catch (error) {
    // ============================================================
    // 7. 错误处理 (Strict Fail for Bad Tokens)
    // ============================================================
    
    // 🔥 修复点：针对 Token 过期或签名错误，必须返回 401
    // 这样才能通过 "Should reject time-expired tokens with 401" 测试
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ msg: 'Token expired', code: 'AUTH_EXPIRED' });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ msg: 'Token invalid', code: 'AUTH_INVALID' });
    }

    // 对于其他未知错误（如 Redis 连接挂了），为了系统稳定性，
    // 可以选择降级为游客，或者返回 500。这里保持 Soft Auth 风格：降级。
    console.error('[Auth Middleware] Unexpected error:', error);
    req.user = null;
    next();
  }
}