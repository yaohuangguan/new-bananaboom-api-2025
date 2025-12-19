const jwt = require("jsonwebtoken");
const redis = require("../cache/cache");
const SECRET = process.env.SECRET_JWT || "secret";

// 注意：这里不再需要引入 User 模型，因为 JWT 直接解密用户信息，不查库
// const User = require("../models/User"); 

module.exports = async function(req, res, next) {
  // 1. 获取 Token
  // 优先尝试获取标准的 Authorization: Bearer <token>
  let token = req.header("x-auth-token");
  const authHeader = req.header("Authorization");

  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. 如果没有 Token，直接拒绝
  if (!token) {
    return res.status(401).json({ message: "No Token, authorization denied" });
  }

  try {
    // 3. Redis 校验 (检查 Token 是否有效/未过期)
    // 逻辑：如果 Redis 里查不到这个 token，说明会话已过期或被强制登出
    const redisToken = await redis.get(token);
    
    // 兼容你之前的逻辑：确保 Redis 里不仅有值，且值等于 token (如果你存的是 key=token, value=token)
    // 如果你 Redis 存的是 key=token, value=userId，这里只要判断 !redisToken 即可
    if (!redisToken || redisToken !== token) {
      return res.status(401).json({ message: "Session expired or logged out" });
    }

    // 4. JWT 解密
    const decoded = jwt.verify(token, SECRET);
    
    // 5. 挂载用户信息到 req 对象
    req.user = decoded.user;

    // ⚡️ 统一 ID 格式 (为了防止后端混用 _id 和 id 导致 bug)
    if (req.user._id && !req.user.id) {
        req.user.id = req.user._id;
    }
    if (req.user.id && !req.user._id) {
        req.user._id = req.user.id;
    }

    req.user.token = token;
    req.userId = req.user.id; // 兼容旧代码

    next();

  } catch (error) {
    // 细分错误日志：如果是 Token 过期，不要打印 Stack Trace 吓自己
    if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ message: "Token Expired" });
    }
    
    console.error("Auth Middleware Error:", error.message);
    res.status(401).json({ message: "Token Invalid" });
  }
};