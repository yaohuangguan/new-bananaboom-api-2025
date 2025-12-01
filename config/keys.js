
// 生产环境(Google Cloud) 会自动注入这些变量
// 本地开发环境 会从 .env 文件读取

module.exports = {
  mongoURI: process.env.MONGO_URI,
  secretOrKey: process.env.JWT_SECRET || 'secret' // 给个默认值防止报错
};