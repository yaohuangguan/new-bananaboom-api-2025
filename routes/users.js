const express = require("express");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const redis = require("../cache/cache");
const getCreateTime = require("../utils")
const checkPrivate = require("../middleware/checkPrivate"); // 引入新中间件
const logOperation = require("../utils/audit"); // 引入工具


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

// @route   GET api/users
// @desc    获取所有用户 (支持分页、搜索、动态排序)
// @access  Private
router.get("/", auth, async (req, res) => {
  try {
    // 1. 分页参数
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2. 排序参数
    // sortBy: 前端想按哪个字段排 (比如 'date', 'name', 'email')
    // order: 'asc' (正序) 或 'desc' (倒序)
    const sortBy = req.query.sortBy || "date"; // 默认按注册时间
    const order = req.query.order === "asc" ? 1 : -1; // 默认倒序 (最新在前)

    // 构建排序对象 { date: -1 } 或 { name: 1 }
    const sortOptions = { [sortBy]: order };

    // 3. 搜索参数
    const { search } = req.query;
    let query = {};

    if (search) {
      query = {
        $or: [
          { displayName: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } }
        ]
      };
    }

    // 4. 查询数据库
    const [users, total] = await Promise.all([
      User.find(query)
        .sort(sortOptions) // 🔥 使用动态排序对象
        .skip(skip)
        .limit(limit)
        .select("-password"), // 依然要排除密码
      
      User.countDocuments(query)
    ]);

    // 5. 返回结果
    res.json({
      data: users,
      pagination: {
        currentPage: page,
        limit: limit,
        totalPages: Math.ceil(total / limit),
        totalUsers: total
      }
    });

  } catch (err) {
    console.error("获取用户列表失败:", err.message);
    res.status(500).send("Server Error");
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
      .custom((value, { req, _loc, _path }) => {
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
      logOperation({
        operatorId: req.user.id,
        action: "SIGN_UP",
        target: `SIGN UP [${user.displayName}]`,
        details: {user},
        ip: req.ip,
        io: req.app.get('socketio')
    });
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
      logOperation({
        operatorId: user.id,
        action: "SIGN_IN",
        target: `SIGN IN [${email}]`,
        details: {},
        ip: req.ip,
        io: req.app.get('socketio')
    });
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


// 1. 修改 Token 生成逻辑
function signToken(payload) {
  // 建议直接用字符串格式，清晰明了
  // '7d' = 7天, '30d' = 30天
  return jwt.sign(payload, SECRET, {
    expiresIn: "30d" 
  });
}

// 2. 修改 Redis 存储逻辑
function setToken(key, value) {
  // 注意：Redis 也需要设置过期时间，否则内存会爆
  // 30天 = 30 * 24 * 60 * 60 = 2592000 秒
  // 'EX' 代表单位是秒
  return Promise.resolve(redis.set(key, value, 'EX', 2592000));
}

function sendToken(req, res, token) {
  res.json({ token });
}

function deleteToken(token) {
  return Promise.resolve(redis.del(token));
}

// @route   PUT /api/users/password
// @desc    Change password
// @access  Private (需要登录)
router.put("/password", auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  // 1. 简单校验：前端必须传两个密码
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: "Please provide old and new passwords" });
  }

  // 2. 校验新密码长度 (可选，建议加)
  if (newPassword.length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters" });
  }

  try {
    // 3. 在数据库找当前用户
    // req.user.id 来自 auth 中间件的解析
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 4. 特殊情况处理：如果是 Google 登录用户，可能没有 password 字段
    if (!user.password) {
      return res.status(400).json({ message: "You use Google Login, no password to change." });
    }

    // 5. 验证旧密码是否正确
    // bcrypt.compare(明文, 数据库里的哈希)
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid old password" });
    }

    // 6. 加密新密码
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    // 7. 保存更新
    await user.save();

    res.json({ message: "Password updated successfully" });

  } catch (err) {
    console.error("Change password error:", err.message);
    res.status(500).send("Server Error");
  }
});

// @route   POST /api/users/reset-by-secret
// @desc    【私域专用】通过超级暗号直接重置密码
// @access  Public
router.post("/reset-by-secret", async (req, res) => {
  const { email, newPassword, secretKey } = req.body;

  // 1. 简单的参数校验
  if (!email || !newPassword || !secretKey) {
    return res.status(400).json({ message: "请填写邮箱、新密码和超级暗号" });
  }

  // 2. 验证超级暗号 (这是安全的关键！)
  // 建议把这个字符串放在环境变量里，或者直接硬编码在这里也行（反正私用）
  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || "bananaboom-666"; 

  if (secretKey !== ADMIN_SECRET) {
    return res.status(403).json({ message: "暗号错误！你不是自己人。" });
  }

  try {
    // 3. 查找用户
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "找不到这个邮箱的用户" });
    }

    // 4. 直接加密新密码并保存
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    await user.save();
    // 🔥🔥🔥 记录日志
    logOperation({
      operatorId: req.user.id,
      action: "RESET_BY_SECRET",
      target: `密码已通过暗号强制重置 [${email}]`,
      details: {},
      ip: req.ip,
      io: req.app.get('socketio')
  });

    res.json({ success: true, message: "密码已通过暗号强制重置！请直接登录。" });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// @route   PUT /api/users/grant-vip
// @desc    【私域专用】给指定用户开通 VIP 权限
// @access  Private (需要 VIP 权限才能操作)
router.put("/grant-vip", auth, checkPrivate, async (req, res) => {
  const { email, username } = req.body;

  // 1. 校验参数：必须提供邮箱或用户名其中之一
  if (!email && !username) {
    return res.status(400).json({ message: "请提供目标用户的邮箱或用户名" });
  }

  try {
    let targetUser = null;

    // 2. 查找用户
    if (email) {
      targetUser = await User.findOne({ email });
    } else if (username) {
      // 注意：你的 User 模型里用户名字段叫 'displayName'
      targetUser = await User.findOne({ displayName: username });
    }

    if (!targetUser) {
      return res.status(404).json({ message: "找不到该用户" });
    }

    // 3. 核心操作：修改 VIP 状态
    targetUser.vip = true;
    await targetUser.save();

    console.log(`User [${targetUser.displayName}] has been promoted to VIP by [${req.user.name}]`);

     // 🔥🔥🔥 记录日志
     logOperation({
      operatorId: req.user.id,
      action: "GRANT_VIP",
      target: `User [${targetUser.displayName}] has been promoted to VIP by [${req.user.name}]`,
      details: {},
      ip: req.ip,
      io: req.app.get('socketio')
  });

    res.json({ 
      success: true, 
      message: `成功！用户 ${targetUser.displayName} 现在已经是 VIP 了。`,
      user: {
          id: targetUser.id,
          name: targetUser.displayName,
          vip: targetUser.vip
      }
    });

  } catch (err) {
    console.error("Grant VIP error:", err.message);
    res.status(500).send("Server Error");
  }
});

// @route   PUT /api/users/:id
// @desc    修改个人资料 (名字、头像)
// @access  Private
router.put("/:id", auth, async (req, res) => {
  const { displayName, photoURL } = req.body;
  const userId = req.params.id;

  // 1. 安全检查：确保用户只能修改自己的资料
  // req.user.id 来自 auth 中间件解析的 token
  if (req.user.id !== userId) {
    return res.status(403).json({ message: "你无权修改他人的资料" });
  }

  // 2. 构建更新对象 (只更新传了的字段)
  const updateFields = {};
  if (displayName) updateFields.displayName = displayName;
  if (photoURL) updateFields.photoURL = photoURL;

  // 如果没有要更新的字段，直接返回
  if (Object.keys(updateFields).length === 0) {
    return res.status(400).json({ message: "请提供要修改的名字或头像" });
  }

  try {
    // 3. 执行更新
    // { new: true } 表示返回更新后的数据
    // .select("-password") 表示返回的数据里不要带密码
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateFields },
      { new: true }
    ).select("-password -googleId"); // 排除敏感信息

    if (!updatedUser) {
      return res.status(404).json({ message: "用户不存在" });
    }

    logOperation({
      operatorId: req.user.id,
      action: "UPDATE_USER_INFO",
      target: `UPDATE_USER_INFO [${req.user.name}]`,
      details: {},
      ip: req.ip,
      io: req.app.get('socketio')
  });

    // 4. 返回标准格式
    res.json({
      success: true,
      message: "修改成功",
      user: updatedUser
    });

  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "修改失败，服务器错误" });
  }
});


module.exports = router;
