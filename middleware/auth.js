/**
 * @module middleware/auth
 * @description 认证中间件：负责 JWT 校验、Session 白名单检查及用户信息实时补全
 */

import jwt from 'jsonwebtoken';
import { get } from '../cache/session.js'; // 这里的 cache 是操作 MongoDB Session 表的助手
import permissionService from '../services/permissionService.js'; // 权限服务
const SECRET = process.env.SECRET_JWT || 'secret';

export default async function (req, res, next) {
  // 1. 提取 Token (支持自定义 Header x-auth-token 或标准 Authorization Bearer 格式)
  let token = req.header('x-auth-token');
  const authHeader = req.header('Authorization');

  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // ============================================================
  // A. 游客模式处理
  // ============================================================
  if (!token) {
    return next(); // 无 Token 直接交由后续的 GlobalGuard 处理权限限制
  }

  try {
    // ============================================================
    // B. 安全校验：JWT 真伪
    // ============================================================
    // 确保 Token 是由本服务器签发的且未过期
    jwt.verify(token, SECRET);

    // ============================================================
    // C. 状态校验：Session 白名单 (防止黑名单/已登出 Token 逃逸)
    // ============================================================
    // 🔥 关键修正：必须带上 "auth:" 前缀去查询，因为 setToken 时加了前缀
    const userIdInSession = await get(`auth:${token}`);

    // 如果 Session 不存在，说明用户已主动登出、被管理员强制失效或 Session 已过期
    if (!userIdInSession) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or logged out',
        message_cn: '登录已失效，请重新登录'
      });
    }

    // ============================================================
    // D. 核心补足：实时获取“满配”用户信息 (通过 buildUserPayload 保证字段不炸)
    // ============================================================
    // 我们不直接信任 JWT 里可能过时的数据，而是通过 userId 实时获取最新快照
    // 该方法内部调用了 buildUserPayload，并自带 5 秒短缓存，性能与实时性兼顾
    const liveUser = await permissionService.getLiveUserPayload(userIdInSession);

    if (!liveUser) {
      return res.status(401).json({
        success: false,
        message: 'Session expired',
        message_cn: '登录已失效'
      });
    }

    // ============================================================
    // E. 挂载数据与兼容性处理
    // ============================================================
    // 挂载由 PermissionService 统一构造的 Payload 对象（包含 phone, permissions 等所有字段）
    req.user = liveUser;

    // 统一 ID 格式兼容 (确保 id 和 _id 同时存在，防止后续业务代码崩溃)
    if (req.user._id && !req.user.id) req.user.id = req.user._id;
    if (req.user.id && !req.user._id) req.user._id = req.user.id;

    // 附带原始 token，方便后续业务逻辑（如登出、级联调用）使用
    req.user.token = token;
    req.userId = req.user.id;

    next(); // ✅ 认证成功，进入下一个中间件（通常是 GlobalGuard）
  } catch (error) {
    // ============================================================
    // F. 错误处理
    // ============================================================
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token Expired',
        message_cn: '登录已超时，请重新登录'
      });
    }

    console.error('[Auth Middleware Error]:', error.message);
    res.status(401).json({
      success: false,
      message: 'Token Invalid',
      message_cn: '身份验证失败，请重新登录'
    });
  }
}
