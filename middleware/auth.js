const jwt = require("jsonwebtoken");
const redis = require("../cache/cache");
const SECRET = process.env.SECRET_JWT || "secret";

module.exports = async function(req, res, next) {
  // 1. 获取 Token
  let token = req.header("x-auth-token");
  const authHeader = req.header("Authorization");

  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // ============================================================
  // 🔥 核心改动：如果是游客 (没带Token)，直接放行！
  // 此时 req.user 为 undefined，交给 GlobalGuard 去判断是否允许通过
  // ============================================================
  if (!token) {
    return next(); 
  }

  // 2. 如果带了 Token，就必须验证真伪
  try {
    // A. Redis 校验 (防黑名单/强制登出)
    const redisToken = await redis.get(token);
    
    // 如果 Redis 里没有，说明 Token 虽然格式对但已失效 (被登出)
    if (!redisToken || redisToken !== token) {
      return res.status(401).json({ message: "Session expired or logged out" });
    }

    // B. JWT 解密
    const decoded = jwt.verify(token, SECRET);
    
    // C. 挂载用户信息
    req.user = decoded.user;

    // D. 统一 ID 格式 (兼容性处理)
    if (req.user._id && !req.user.id) req.user.id = req.user._id;
    if (req.user.id && !req.user._id) req.user._id = req.user.id;

    req.user.token = token;
    req.userId = req.user.id;

    next(); // ✅ 验证通过，带上身份证(req.user)放行

  } catch (error) {
    // 3. 只要带了 Token 但验证失败，一律 401
    // (说明用户试图欺骗服务器，或者 Token 过期了)
    if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ message: "Token Expired" });
    }
    
    console.error("Auth Middleware Error:", error.message);
    res.status(401).json({ message: "Token Invalid" });
  }
};