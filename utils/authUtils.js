/**
 * @module utils/authUtils
 */
const jwt = require("jsonwebtoken");
const cache = require("../cache/session"); // 操作 MongoDB Session 表
const permissionService = require("../services/permissionService");
const SECRET = process.env.SECRET_JWT || "secret";

/**
 * 签发 Token 并同步到 Session
 */
const signAndSyncToken = async (user) => {
    // 1. 🔥 使用统一构造器生成 Payload
    // 这样签发出的 Token 内部也包含完整的 phone, name 等字段，前端解密即用
    const payload = {
        user: permissionService.buildUserPayload(user)
    };

    // 2. 签发 JWT
    const token = jwt.sign(payload, SECRET, { expiresIn: "30d" });

    // 3. 🔥 存入 Session 白名单 (必须带 auth: 前缀)
    // Value 建议存 userId，方便后面 auth 中间件实时补全
    await cache.set(`auth:${token}`, user._id.toString());

    return token;
};

module.exports = { signAndSyncToken };