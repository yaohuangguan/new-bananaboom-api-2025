const whitelist = [
  "http://localhost:3000",
  "http://106.15.47.226",
  "https://106.15.47.226",
  "https://www.ps5.space",
];
const corsConfig = {
  origin: function (origin, callback) {
    // allow requests with no origin
    // (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (whitelist.indexOf(origin) === -1) {
      var msg =
        "跨域请求不允许" +
        "allow access from the specified Origin.";
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
};

module.exports = corsConfig;
