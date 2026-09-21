const whitelist = [
  // 正式域名：旧域名继续兼容到下线，新域名并行使用
  'https://samyao.me',
  'https://www.samyao.me',
  'https://ps6.space',
  'https://www.ps6.space',
  'http://ps6.space',

  // Vercel 前端部署地址
  'https://bananaboom-frontend.vercel.app',
  "http://localhost:5173"
];

// 需要模糊匹配的域名后缀 (专门针对 AI Studio 预览地址)
const allowedSuffixes = [
  '.scf.usercontent.goog',
  '.samyao.me',
  '.ps6.space',
  '.vercel.app',
  '.run.app' // 兼容 Cloud Run 的自动域名
];

const corsConfig = {
  origin: function (origin, callback) {
    // 1. 允许没有 origin 的请求 (如 Postman, App)
    if (!origin) return callback(null, true);

    // 2. 检查精确白名单
    if (whitelist.indexOf(origin) !== -1) {
      return callback(null, true);
    }

    // 3. 🔥 智能检查动态子域名 (AI Studio)
    // 检查请求来源是否以允许的后缀结尾
    const isAllowedSuffix = allowedSuffixes.some((suffix) => origin.endsWith(suffix));

    if (isAllowedSuffix) {
      return callback(null, true);
    }

    // 4. 都没匹配上 -> 拒绝
    var msg = 'CORS Error: 跨域请求不允许，来源: ' + origin;
    return callback(new Error(msg), false);
  },
  credentials: true
};

export default corsConfig;
