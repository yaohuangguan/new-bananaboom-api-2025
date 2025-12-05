const jwt = require("jsonwebtoken");
const User = require("../models/User");
const redis = require("../cache/cache");

const SECRET = process.env.SECRET_JWT || "secret";

module.exports = async function(req, res, next) {
  const token = req.header("x-auth-token");
  const googleToken = req.header("x-google-auth");

  // ==========================================
  // 分支 A: Google 登录
  // ==========================================
  if (googleToken) {
    try {
      // ⚠️ 安全提示：在生产环境中，不要直接信任 header 里的 email/googleId。
      // 别人如果知道你的邮箱，可以用 Postman 伪造这个 Header 登录你的号。
      // 现在的阶段（个人用/内网用）为了方便没问题，上线前建议改成验证 Google ID Token。
      
      let user = await User.findOne({ googleId: googleToken });
      if (!user) {
         user = await User.findOne({ email: googleToken });
      }

      if (!user) {
        return res.status(401).json({ message: "Google User not found in DB" });
      }

      // 挂载 req.user
      req.user = {
        id: user._id, // 注意：user._id 是个对象，有时候转 string 更保险
        name: user.displayName,
        email: user.email,
        vip: user.vip
      };
      
      // 🔥 补丁：同时挂载 req.userId，兼容旧代码
      req.userId = user._id.toString(); 

      return next(); 

    } catch (err) {
      console.error("Google Auth Error:", err);
      return res.status(500).json({ message: "Server Error" });
    }
  }

  // ==========================================
  // 分支 B: JWT 登录
  // ==========================================
  if (!token) {
    return res.status(401).json({ message: "No Token, authorization denied" });
  }

  try {
    // 1. Redis 检查
    const redisToken = await redis.get(token);
    if (!redisToken || redisToken !== token) {
      return res.status(401).json({ message: "Session expired (Redis)" });
    }

    // 2. JWT 验证
    const decoded = jwt.verify(token, SECRET);

    // 3. 挂载
    req.user = decoded.user;
    req.user.token = token;

    // 🔥 补丁：同时挂载 req.userId，兼容旧代码
    // 确保 decoded.user.id 存在
    if (decoded.user && decoded.user.id) {
        req.userId = decoded.user.id;
    }

    next();

  } catch (error) {
    console.error("JWT Error:", error.message);
    res.status(401).json({ message: "Token is not valid" });
  }
};