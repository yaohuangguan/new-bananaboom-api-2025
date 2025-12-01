const GoogleStrategy = require("passport-wechat")
const User = require("../models/User");

// const wechat = new WechatStrategy({
//   appID: {APPID},
//   name:{默认为wechat,可以设置组件的名字}
//   appSecret: {APPSECRET},
//   client:{wechat|web},
//   callbackURL: {CALLBACKURL},
//   scope: {snsapi_userinfo|snsapi_base},
//   state:{STATE},
//   getToken: {getToken},
//   saveToken: {saveToken}
// },
// function(accessToken, refreshToken, profile, done) {
//   return done(err,profile);
// }
// )
