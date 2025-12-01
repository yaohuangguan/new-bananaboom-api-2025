const jwt = require("jsonwebtoken");
const SECRET  = process.env.SECRET_JWT  || require('../config/keys').SECRET_JWT
const redis = require("../cache/cache");
function getToken(token) {
  return Promise.resolve(redis.get(token));
}
module.exports = async function(req, res, next) {
  const token = req.header("x-auth-token");
  const googleToken = req.header("x-google-auth");
  if (googleToken) {
   return next();
  }
  if (!token) {
    return res.status(401).json("No Token, failed");
  }
  const redisToken = await getToken(token);

  if (redisToken !== token)
    return res.status(401).json("token not the same, expired");
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded.user;
    req.user.token = token;
    next();
  } catch (error) {
    console.log(error);
    res.status(401).json("Token not valid");
  }
};
