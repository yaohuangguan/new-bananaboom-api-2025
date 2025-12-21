const express = require("express");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const redis = require("../cache/cache");
const getCreateTime = require("../utils")
const checkPrivate = require("../middleware/checkPrivate");
const logOperation = require("../utils/audit");
const checkPermission = require('../middleware/checkPermission');
const K = require('../config/permissionKeys');
const PERMISSIONS = require('../config/permissions'); // 🔥 引入权限字典

const SECRET = process.env.SECRET_JWT || require("../config/keys").SECRET_JWT;
const router = express.Router();
const { check, validationResult } = require("express-validator");

// ==========================================
// 🛠️ 辅助函数：计算合并权限 (Role + Extra)
// ==========================================
const getMergedPermissions = (user) => {
  const rolePerms = PERMISSIONS[user.role] || [];
  const extraPerms = user.extraPermissions || [];
  // 合并并去重
  return [...new Set([...rolePerms, ...extraPerms])];
};

// ==========================================
// 👤 获取当前用户信息 (Load User)
// ==========================================
router.get("/profile", auth, async (req, res) => {
  try {
    const { id } = req.user;
    let user = await User.findById(id).select("-password +barkUrl");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 转为普通对象以便修改
    let userObj = user.toObject();

    // 🔥 1. 注入权限列表
    userObj.permissions = getMergedPermissions(user);

    // 🔥 2. VIP 彩蛋逻辑 (保持原样)
    if (user.vip) {
      userObj.private_token = "ilovechenfangting";
    }

    return res.json(userObj);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// @route   GET api/users
// @desc    获取所有用户 (支持分页、搜索、自定义权重排序)
// @access  Private
router.get("/", auth, async (req, res) => {
  try {
    // 1. 分页参数
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2. 搜索参数 (保持不变)
    const { search } = req.query;
    let matchQuery = {};

    if (search) {
      matchQuery = {
        $or: [
          { displayName: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } }
        ]
      };
    }

    // 3. 排序逻辑处理
    const sortBy = req.query.sortBy; // 前端传来的排序字段
    const order = req.query.order === "asc" ? 1 : -1;

    let users = [];
    let total = 0;

    // ============================================================
    // 场景 A: 默认排序 OR 按角色排序 (需要走聚合管道，实现自定义权重)
    // ============================================================
    // 如果没有传 sortBy，或者明确要求 sortBy=role，就走这套逻辑
    if (!sortBy || sortBy === 'role') {
      
      const pipeline = [
        // 1. 筛选 (Search)
        { $match: matchQuery },

        // 2. 🔥 核心：添加权重字段 (用于排序)
        {
          $addFields: {
            roleWeight: {
              $switch: {
                branches: [
                  { case: { $eq: ["$role", "super_admin"] }, then: 3 }, // 权重最高
                  { case: { $eq: ["$role", "admin"] }, then: 2 },
                  { case: { $eq: ["$role", "user"] }, then: 1 },
                  { case: { $eq: ["$role", "bot"] }, then: 0 }       // 机器人排最后
                ],
                default: 0
              }
            }
          }
        },

        // 3. 🔥 排序
        // 先按权重降序 (3->2->1)，如果权重相同(同级)，按注册时间降序(最新在前)
        { $sort: { roleWeight: -1, date: -1 } },

        // 4. 分页
        { $skip: skip },
        { $limit: limit },

        // 5. 数据清洗 (去掉临时生成的 roleWeight 字段，去掉密码)
        { $project: { password: 0, roleWeight: 0 } }
      ];

      // 并行执行：获取数据(聚合) + 获取总数(Count)
      const [aggUsers, count] = await Promise.all([
        User.aggregate(pipeline),
        User.countDocuments(matchQuery)
      ]);

      users = aggUsers;
      total = count;
    } 
    
    // ============================================================
    // 场景 B: 普通排序 (按名字、邮箱、日期等简单字段排序)
    // ============================================================
    else {
      const sortOptions = { [sortBy]: order };
      
      const [findUsers, count] = await Promise.all([
        User.find(matchQuery)
          .sort(sortOptions)
          .skip(skip)
          .limit(limit)
          .select("-password"),
        User.countDocuments(matchQuery)
      ]);

      users = findUsers;
      total = count;
    }

    // 4. 返回结果
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

// @route   POST api/users (注册)
router.post(
  "/",
  [
    check("displayName", "Please provide a name").not().isEmpty(),
    check("email", "Please provide a valid email").isEmail(),
    check("password", "Please enter a password and not less than 8 characters")
      .isLength({ min: 8 })
      .custom((value, { req }) => {
        let re = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
        if (value !== req.body.passwordConf) {
          throw new Error("Passwords don't match");
        } else if (!re.test(value)) {
          throw new Error("Password should have letters and numbers and more than 8 characters.");
        }
        return value;
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
          id: user.id,
          displayName: user.displayName,
          name: user.displayName,
          email: user.email,
          photoURL: user.photoURL || "",
          vip: false,
          role: 'user'
        }
      };

      const token = signToken(payload);
      await setToken(token, token);
      
      logOperation({
        operatorId: user.id,
        action: "SIGN_UP",
        target: `SIGN UP [${user.displayName}]`,
        details: { user },
        ip: req.ip,
        io: req.app.get('socketio')
      });
      
      // 注册成功也返回用户信息和权限
      const userObj = user.toObject();
      delete userObj.password;
      userObj.permissions = getMergedPermissions(user);

      res.json({ token, user: userObj });

    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "Error out" });
    }
  }
);

// @route   POST api/users/signin (登录)
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

      // Payload 用于生成 Token
      const payload = {
        user: {
          id: user.id,
          displayName: user.displayName,
          name: user.displayName,
          email: user.email,
          photoURL: user.photoURL,
          vip: user.vip,
          role: user.role // 🔥🔥🔥 必须加上这一行！🔥🔥🔥
        }
      };

      const token = signToken(payload);
      await setToken(token, token);

      logOperation({
        operatorId: user.id,
        action: "SIGN_IN",
        target: `SIGN IN [${email}]`,
        details: { user },
        ip: req.ip,
        io: req.app.get('socketio')
      });

      // 🔥🔥🔥 改动：登录直接返回 User 信息和 Permissions
      // 这样前端登录完不需要再请求一次 /profile 就能渲染菜单
      let userObj = user.toObject();
      delete userObj.password;
      delete userObj.__v;
      userObj.permissions = getMergedPermissions(user);

      res.json({ token, user: userObj });

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

// 1. Token 生成逻辑
function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: "30d" });
}

// 2. Redis 存储逻辑
function setToken(key, value) {
  return Promise.resolve(redis.set(key, value, 'EX', 2592000));
}

function deleteToken(token) {
  return Promise.resolve(redis.del(token));
}

// @route   PUT /api/users/password
router.put("/password", auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: "Please provide old and new passwords" });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters" });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.password) {
      return res.status(400).json({ message: "You use Google Login, no password to change." });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid old password" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ message: "Password updated successfully" });

  } catch (err) {
    console.error("Change password error:", err.message);
    res.status(500).send("Server Error");
  }
});

// @route   PUT /api/users/fitness-goal
router.put("/fitness-goal", auth, async (req, res) => {
  const { goal, userId } = req.body;

  if (!['cut', 'bulk', 'maintain'].includes(goal)) {
    return res.status(400).json({ msg: "无效的模式" });
  }

  try {
    const user = await User.findById(userId);
    user.fitnessGoal = goal;
    await user.save(); 

    res.json({ 
      success: true, 
      msg: "模式已更新",
      goal: user.fitnessGoal
    });
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

// @route   POST /api/users/reset-by-secret
router.post("/reset-by-secret", async (req, res) => {
  const { email, newPassword, secretKey } = req.body;

  if (!email || !newPassword || !secretKey) {
    return res.status(400).json({ message: "请填写邮箱、新密码和超级暗号" });
  }

  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || "bananaboom-666"; 

  if (secretKey !== ADMIN_SECRET) {
    return res.status(403).json({ message: "暗号错误！你不是自己人。" });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "找不到这个邮箱的用户" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    await user.save();
    
    logOperation({
      operatorId: req.user.id, // 注意：如果未登录调用此接口，req.user可能不存在，建议判空处理
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
router.put("/grant-vip", auth, checkPrivate, async (req, res) => {
  const { email, username } = req.body;

  if (!email && !username) {
    return res.status(400).json({ message: "请提供目标用户的邮箱或用户名" });
  }

  try {
    let targetUser = null;
    if (email) {
      targetUser = await User.findOne({ email });
    } else if (username) {
      targetUser = await User.findOne({ displayName: username });
    }

    if (!targetUser) {
      return res.status(404).json({ message: "找不到该用户" });
    }

    targetUser.vip = true;
    await targetUser.save();

    console.log(`User [${targetUser.displayName}] has been promoted to VIP by [${req.user.name}]`);

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

// @route   PUT /api/users/revoke-vip
router.put("/revoke-vip", auth, checkPrivate, async (req, res) => {
  const { email, username } = req.body;
  if (!email && !username) {
    return res.status(400).json({ message: "请提供目标用户的邮箱或用户名" });
  }

  try {
    const targetUser = await User.findOne({
      $or: [
        { email: email },
        { displayName: username }
      ]
    });

    if (!targetUser) {
      return res.status(404).json({ message: "未找到该用户" });
    }

    targetUser.vip = false;
    await targetUser.save();

    res.json({ 
      message: `已成功取消用户 [${targetUser.displayName}] 的 VIP 权限`,
      user: {
          id: targetUser._id,
          email: targetUser.email,
          displayName: targetUser.displayName,
          vip: targetUser.vip
      }
    });

  } catch (err) {
    console.error("取消 VIP 失败:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// @route   PUT /api/users/:id
// @desc    修改个人资料 (名字、头像、身高、健身目标, 时区，barkUrl)
router.put("/:id", auth, async (req, res) => {
  const { displayName, photoURL, height, fitnessGoal, barkUrl, timezone } = req.body;
  const userId = req.params.id;

  if (req.user.id !== userId) {
    return res.status(403).json({ message: "你无权修改他人的资料" });
  }

  try {
    const user = await User.findById(userId).select('+barkUrl');

    if (!user) {
      return res.status(404).json({ message: "用户不存在" });
    }

    const changes = {};

    if (displayName) {
      user.displayName = displayName;
      changes.displayName = displayName;
    }
    
    if (photoURL) {
      user.photoURL = photoURL;
      changes.photoURL = photoURL;
    }

    if (barkUrl) {
      user.barkUrl = barkUrl;
      changes.barkUrl = barkUrl;
    }

    if (timezone) {
      user.timezone = timezone;
      changes.timezone = timezone;
    }

    if (height) {
      const heightNum = Number(height);
      if (!isNaN(heightNum) && heightNum > 0) {
        user.height = heightNum;
        changes.height = heightNum;
      }
    }

    if (fitnessGoal) {
      const allowedGoals = ['cut', 'bulk', 'maintain'];
      if (allowedGoals.includes(fitnessGoal)) {
        user.fitnessGoal = fitnessGoal;
        changes.fitnessGoal = fitnessGoal;
      }
    }

    if (Object.keys(changes).length === 0) {
       return res.json({ success: true, message: "资料未变动", user });
    }

    // 🔥 .save() 触发 VIP/Role 同步钩子
    const updatedUser = await user.save();

    // 数据脱敏 + 权限注入
    const userObj = updatedUser.toObject();
    delete userObj.password;
    delete userObj.googleId;
    delete userObj.__v;
    // 🔥 重新计算权限 (因为角色可能变了)
    userObj.permissions = getMergedPermissions(updatedUser);

    if (typeof logOperation === 'function') {
        logOperation({
          operatorId: req.user.id,
          action: "UPDATE_USER_INFO",
          target: `UPDATE_USER_INFO [${req.user.name || displayName}]`,
          details: changes,
          ip: req.ip,
          io: req.app.get('socketio')
        });
    }

    res.json({
      success: true,
      message: "修改成功",
      user: userObj
    });

  } catch (error) {
    console.error("Update profile error:", error);
    if (error.name === 'ValidationError') {
       return res.status(400).json({ message: "参数错误: " + error.message });
    }
    res.status(500).json({ message: "修改失败，服务器错误" });
  }
});

// @route   PUT /api/users/:id/role
// @desc    修改用户角色 (权限管理)
router.put("/:id/role", auth, async (req, res) => {
  const targetUserId = req.params.id;
  const { role: newRole } = req.body;

  const ALLOWED_ROLES = ['user', 'admin', 'super_admin', 'bot'];
  if (!ALLOWED_ROLES.includes(newRole)) {
    return res.status(400).json({ msg: "无效的角色类型" });
  }

  try {
    const requester = await User.findById(req.user.id);
    if (!requester) return res.status(401).json({ msg: "操作人不存在" });

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) return res.status(404).json({ msg: "目标用户不存在" });

    // 权限逻辑
    if (requester.role === 'user') {
      return res.status(403).json({ msg: "权限不足：普通用户无法修改角色" });
    }
    if (requester.role === 'admin') {
      if (newRole === 'super_admin') return res.status(403).json({ msg: "权限不足：Admin 不能任命超级管理员" });
      if (targetUser.role === 'super_admin') return res.status(403).json({ msg: "权限不足：Admin 无法修改超级管理员的账号" });
    }

    if (targetUser.role === newRole) {
      return res.status(400).json({ msg: "该用户已经是这个角色了" });
    }

    targetUser.role = newRole;
    await targetUser.save(); // 触发 Hook

    console.log(`👮 [Role Change] ${requester.displayName} changed ${targetUser.displayName} to ${newRole}`);

    // 🔥 返回带权限的用户对象
    const userObj = targetUser.toObject();
    delete userObj.password;
    userObj.permissions = getMergedPermissions(targetUser);

    res.json({ 
      success: true, 
      msg: `修改成功！用户 ${targetUser.displayName} 现在是 ${newRole}`,
      user: userObj
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// @route   PUT /api/users/:id/permissions
// @desc    授予/修改用户额外权限 (Super Admin Only)
router.put("/:id/permissions", 
  auth, 
  checkPermission('*'), 
  async (req, res) => {
    const userId = req.params.id;
    const { permissions } = req.body;

    if (!Array.isArray(permissions)) {
      return res.status(400).json({ msg: "Permissions must be an array" });
    }

    try {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ msg: "User not found" });

      // 安全过滤
      const validPermissionKeys = Object.values(K);
      const cleanPermissions = permissions.filter(p => {
        const isValid = validPermissionKeys.includes(p);
        if (!isValid) console.warn(`⚠️ Warning: Ignoring invalid permission key: ${p}`);
        return isValid;
      });

      user.extraPermissions = cleanPermissions;
      await user.save();

      console.log(`👮 [Permission Grant] ${req.user.displayName} gave [${cleanPermissions}] to ${user.displayName}`);

      // 返回结果
      const userObj = user.toObject();
      delete userObj.password;
      delete userObj.googleId;
      delete userObj.__v;
      // 🔥 别忘了注入合并后的最终权限
      userObj.permissions = getMergedPermissions(user);

      res.json({
        success: true,
        msg: `权限已更新，${user.displayName} 现在拥有: ${cleanPermissions.join(', ')}`,
        user: userObj
      });

    } catch (err) {
      console.error(err);
      res.status(500).send("Server Error");
    }
  }
);

module.exports = router;