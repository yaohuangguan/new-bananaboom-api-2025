// const whitelist = [
//   "http://localhost:3000",
//   "http://106.15.47.226",
//   "https://106.15.47.226",
//   "https://www.ps5.space",
// ];

const corsConfig = {
  origin: function (origin, callback) {
      // 🔥【修改点在这里】🔥
      // 直接返回 true，允许所有来源。
      // 等以后前端开发完了，上线前把这一行注释掉，就能恢复严格模式。
      return callback(null, true);

      // -------------------------------------------------------
      // 下面是原来的逻辑（现在暂时不会执行到了）
      // -------------------------------------------------------
      // allow requests with no origin
      // if (!origin) return callback(null, true);
      // if (whitelist.indexOf(origin) === -1) {
      //     var msg = 
      //         "跨域请求不允许" + 
      //         "allow access from the specified Origin.";
      //     return callback(new Error(msg), false);
      // }
      // return callback(null, true);
  },
  credentials: true // 建议加上这一行，允许携带 Token/Cookies
};

module.exports = corsConfig;