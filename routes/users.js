const express = require("express");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const redis = require("../cache/cache");
const getCreateTime = require("../utils")


const SECRET = process.env.SECRET_JWT || require("../config/keys").SECRET_JWT;
const router = express.Router();
const { check, validationResult } = require("express-validator");
router.get("/profile", auth, async (req, res) => {
  const { id } = req.user;
  let user = await User.findOne(
    { _id: id },
    {
      displayName: 1,
      vip: 1,
      email: 1,
      date: 1,
      photoURL: 1
    }
  );
  if (user.vip) {
    let privateUser = { ...user._doc, private_token: "ilovechenfangting" };
    return res.json(privateUser);
  } else {
    return res.json(user);
  }
});

router.post(
  "/",
  [
    check("displayName", "Please provide a name")
      .not()
      .isEmpty(),
    check("email", "Please provide a valid email").isEmail(),
    check("password", "Please enter a password and not less than 8 characters")
      .isLength({ min: 8 })
      .custom((value, { req, loc, path }) => {
        let re = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
        if (value !== req.body.passwordConf) {
          throw new Error("Passwords don't match");
        } else if (!re.test(value)) {
          throw new Error(
            "Password should have letters and numbers and more than 8 characters."
          );
        } else {
          return value;
        }
      })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { displayName, email, password } = req.body;
    try {
      let user = await User.findOne({ email });
      if (user) {
        return res.status(400).json({
          message: "User already exists",
          message_cn: "此邮箱已被占用"
        });
      }

      const date = getCreateTime()
      user = new User({
        email,
        password,
        displayName,
        date
      });
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
      await user.save();
      const payload = {
        user: {
          id: user.id
        }
      };

      const token = signToken(payload);
      await setToken(token, token);
      sendToken(req, res, token);
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "Error out" });
    }
  }
);

router.post(
  "/signin",
  [
    check("email", "Please enter the email you signed up").isEmail(),
    check("password", "Password is required").exists()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email, password } = req.body;
    try {
      let user = await User.findOne({ email });
      if (!user) {
        return res.status(401).json({
          message: "Invalid credentials! Try again",
          message_cn: "你输入的密码和账户名不匹配"
        });
      }
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          message: "Invalid credentials! Try again",
          message_cn: "你输入的密码和账户名不匹配"
        });
      }
      const payload = {
        user: {
          id: user.id
        }
      };

      const token = signToken(payload);
      await setToken(token, token);
      sendToken(req, res, token);
    } catch (error) {
      console.log(error.message);
      res.status(500).json({ message: "Server error" });
    }
  }
);
router.post("/logout", auth, async (req, res) => {
  const { token } = req.user;
  
  await deleteToken(token);
  res.json("OK");
});
router.post("/changeusername/:id", auth, async (req, res) => {
  const { newDisplayName } = req.body;
  const { id } = req.params;
  if (!id) {
    return res.json({ message: "修改失败" });
  }
  try {
    await User.updateOne({ _id: id }, { displayName: newDisplayName });
    let updatedUser = await User.findOne(
      { _id: id },
      {
        displayName: 1,
        email: 1,
        date: 1,
        photoURL: 1,
        vip: 1
      }
    );
    if (updatedUser.vip) {
      let privateUser = {
        updatedUser,
        private_token: "ilovechenfangting",
        message: "修改成功"
      };
      return res.json(privateUser);
    }
    res.json({ newDisplayName, id, message: "修改成功", updatedUser });
  } catch (error) {
    res.status(400).json({ message: "修改失败" });
  }
});
function signToken(payload) {
  return jwt.sign(payload, SECRET, {
    expiresIn: 600000
  });
}
function setToken(key, value) {
  return Promise.resolve(redis.set(key, value));
}
function sendToken(req, res, token) {
  res.json({ token });
}
function deleteToken(token) {
  return Promise.resolve(redis.del(token));
}
module.exports = router;
