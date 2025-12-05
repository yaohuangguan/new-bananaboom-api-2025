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
      let user = await User.findOne({ googleId: googleToken });
      if (!user) user = await User.findOne({ email: googleToken });
      if (!user) return res.status(401).json({ message: "Google User not found" });

      // ✅ 修复点 1：构造标准 user 对象
      req.user = {
        id: user._id.toString(), // ⚡️ 必须转成 String，统一叫 id
        _id: user._id.toString(), // ⚡️ 兼容前端可能取 _id
        name: user.displayName,
        email: user.email,
        vip: user.vip,
        photoURL: user.photoURL
      };
      
      // 兼容旧代码
      req.userId = req.user.id;
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server Error" });
    }
  }

  // ==========================================
  // 分支 B: JWT 登录
  // ==========================================
  if (!token) return res.status(401).json({ message: "No Token" });

  try {
    const redisToken = await redis.get(token);
    if (!redisToken || redisToken !== token) {
      return res.status(401).json({ message: "Session expired" });
    }

    const decoded = jwt.verify(token, SECRET);
    
    // ✅ 修复点 2：确保 JWT 解出来的 user 也有 id
    req.user = decoded.user;
    
    // 如果 token 里存的是 _id，强制补一个 id
    if (req.user._id && !req.user.id) {
        req.user.id = req.user._id;
    }
    // 如果 token 里存的是 id，强制补一个 _id (双保险)
    if (req.user.id && !req.user._id) {
        req.user._id = req.user.id;
    }

    req.user.token = token;
    req.userId = req.user.id; // 兼容旧代码

    next();
  } catch (error) {
    console.error(error);
    res.status(401).json({ message: "Token Invalid" });
  }
};