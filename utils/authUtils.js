/**
 * @module utils/authUtils
 */
import { signSessionJwt } from './jwtKeyring.js';
import { set } from '../cache/session.js'; // 操作 MongoDB Session 表
import permissionService from '../services/permissionService.js';

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
  const token = signSessionJwt(payload);

  // 3. 🔥 存入 Session 白名单 (必须带 auth: 前缀)
  // Value 建议存 userId，方便后面 auth 中间件实时补全
  await set(`auth:${token}`, user._id.toString());

  return token;
};

export { signAndSyncToken };
