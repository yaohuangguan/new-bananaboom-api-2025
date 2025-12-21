/**
 * @module middleware/auth
 * @description 认证中间件：负责 JWT 校验、Session 白名单检查及用户信息实时补全
 */

const jwt = require("jsonwebtoken");
const cache = require("../cache/session"); // 这里的 cache 是操作 MongoDB Session 表的助手
const permissionService = require("../services/permissionService"); // 刚才重构好的服务
const SECRET = process.env.SECRET_JWT || "secret";

module.exports = async function(req, res, next) {
  // 1. 提取 Token (支持自定义 Header 或 标准 Bearer 格式)
  let token = req.header("x-auth-token");
  const authHeader = req.header("Authorization");

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
    const decoded = jwt.verify(token, SECRET);

    // ============================================================
    // C. 状态校验：Session 白名单 (防止黑名单/已登出 Token 逃逸)
    // ============================================================
    // 既然你现在的逻辑是 cache.set(token, token)，我们直接查这个 Key 存不存在
    const sessionToken = await cache.get(token);
    
    // 如果 Session 不存在，说明用户已主动登出或被管理员强制失效
    if (!sessionToken) {
      return res.status(401).json({ 
        message: "Session expired or logged out",
        message_cn: "登录已失效，请重新登录"
      });
    }

    // ============================================================
    // D. 核心补丁：实时获取“满配”用户信息 (解决字段缺失 & 权限滞后)
    // ============================================================
    // 我们不使用 decoded.user 里的旧数据，而是通过 userId 实时获取最新快照
    // 该方法内部自带 5 秒 node-cache 缓存，不会对数据库造成高频压力
    const liveUser = await permissionService.getLiveUserPayload(decoded.user.id);
    
    if (!liveUser) {
      return res.status(401).json({ 
        message: "User account no longer exists",
        message_cn: "该账号已被注销或无法找到"
      });
    }

    // ============================================================
    // E. 挂载数据与兼容性处理
    // ============================================================
    // 挂载由 PermissionService 统一构造的 Payload 对象
    req.user = liveUser; 
    
    // 统一 ID 格式 (确保 id 和 _id 同时存在)
    if (req.user._id && !req.user.id) req.user.id = req.user._id;
    if (req.user.id && !req.user._id) req.user._id = req.user.id;

    // 附带原始 Token，方便后续业务逻辑（如登出、级联调用）使用
    req.user.token = token;
    req.userId = req.user.id;

    next(); // ✅ 认证成功，放行

  } catch (error) {
    // ============================================================
    // F. 错误处理
    // ============================================================
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: "Token Expired",
        message_cn: "登录已超时，请重新登录" 
      });
    }
    
    console.error("[Auth Error]:", error.message);
    res.status(401).json({ 
      message: "Token Invalid",
      message_cn: "身份验证失败，请重新登录"
    });
  }
};