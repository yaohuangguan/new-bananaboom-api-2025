const jwt = require("jsonwebtoken");
const User = require("../models/User"); // 引入 User 模型，用于 Google 登录反查
const redis = require("../cache/cache");

// 优先使用环境变量
const SECRET = process.env.SECRET_JWT || "secret";

module.exports = async function(req, res, next) {
  // 1. 获取 Header 中的 Token
  const token = req.header("x-auth-token");
  const googleToken = req.header("x-google-auth");

  // ==========================================
  // 分支 A: 处理 Google 登录 (修复了直接放行的问题)
  // ==========================================
  if (googleToken) {
    try {
      // 假设前端传来的 googleToken 是 googleId 或者 email
      // 我们需要去数据库里找到这个用户，才能知道他是谁、是不是 VIP
      
      // 尝试通过 googleId 查找用户
      let user = await User.findOne({ googleId: googleToken });
      
      // 如果没找到，尝试通过 email 查找 (取决于你前端传的是什么)
      if (!user) {
         user = await User.findOne({ email: googleToken });
      }

      if (!user) {
        return res.status(401).json({ message: "Google User not found in DB" });
      }

      // ✅ 关键修复：手动给 req.user 赋值
      // 这样后续的 checkPrivate 才能拿到 req.user.id 和 req.user.vip
      req.user = {
        id: user._id,
        name: user.displayName,
        email: user.email,
        vip: user.vip
      };

      return next(); // 验证通过，放行

    } catch (err) {
      console.error("Google Auth Error:", err);
      return res.status(500).json({ message: "Server Error during Google Auth" });
    }
  }

  // ==========================================
  // 分支 B: 处理标准 JWT 登录
  // ==========================================
  if (!token) {
    return res.status(401).json({ message: "No Token, authorization denied" });
  }

  try {
    // 1. 检查 Redis (单点登录/强制登出逻辑)
    // 你的 Redis 逻辑是：Token 必须存在于 Redis 中才算有效
    const redisToken = await redis.get(token);

    if (!redisToken || redisToken !== token) {
      return res.status(401).json({ message: "Session expired or invalid (Redis)" });
    }

    // 2. 验证 JWT 签名
    const decoded = jwt.verify(token, SECRET);

    // 3. 将解密出来的用户信息挂载到 req.user
    // decoded.user 通常包含 { id: "...", ... }
    req.user = decoded.user;
    
    // 把 token 也挂上去，方便后续使用
    req.user.token = token;

    next(); // 验证通过，放行

  } catch (error) {
    console.error("JWT Error:", error.message);
    res.status(401).json({ message: "Token is not valid" });
  }
};