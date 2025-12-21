const express = require("express");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const userSession = require("../cache/session");
const getCreateTime = require("../utils")
const logOperation = require("../utils/audit");
const K = require('../config/permissionKeys');
const permissionService = require('../services/permissionService');
const SECRET = process.env.SECRET_JWT || require("../config/keys").SECRET_JWT;
const router = express.Router();
const {
  check,
  validationResult
} = require("express-validator");

// ==========================================
// 🔧 常量定义 (Regex Patterns)
// ==========================================
// 强密码：至少8位，包含字母和数字
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;

// 国际电话 (E.164 宽松版)：
// - 可选 '+' 开头
// - 后面跟 7 到 15 位数字
const PHONE_REGEX = /^\+?[0-9]{7,15}$/;


// ==========================================
// 👤 获取当前用户信息 (Load User)
// ==========================================
router.get("/profile", async (req, res) => {
  try {
    const {
      id
    } = req.user;
    let user = await User.findById(id).select("-password +barkUrl");

    if (!user) {
      return res.status(404).json({
        message: "User not found"
      });
    }

    // 转为普通对象以便修改
    let userObj = user.toObject();

    // 🔥 1. 注入权限列表
    userObj.permissions = permissionService.getUserMergedPermissions(user);

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
router.get("/", async (req, res) => {
  try {
    // 1. 分页参数
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2. 搜索参数 (保持不变)
    const {
      search
    } = req.query;
    let matchQuery = {};

    if (search) {
      matchQuery = {
        $or: [{
            displayName: {
              $regex: search,
              $options: "i"
            }
          },
          {
            name: {
              $regex: search,
              $options: "i"
            }
          },
          {
            email: {
              $regex: search,
              $options: "i"
            }
          }
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
        {
          $match: matchQuery
        },

        // 2. 🔥 核心：添加权重字段 (用于排序)
        {
          $addFields: {
            roleWeight: {
              $switch: {
                branches: [{
                    case: {
                      $eq: ["$role", "super_admin"]
                    },
                    then: 3
                  }, // 权重最高
                  {
                    case: {
                      $eq: ["$role", "admin"]
                    },
                    then: 2
                  },
                  {
                    case: {
                      $eq: ["$role", "user"]
                    },
                    then: 1
                  },
                  {
                    case: {
                      $eq: ["$role", "bot"]
                    },
                    then: 0
                  } // 机器人排最后
                ],
                default: 0
              }
            }
          }
        },

        // 3. 🔥 排序
        // 先按权重降序 (3->2->1)，如果权重相同(同级)，按注册时间降序(最新在前)
        {
          $sort: {
            roleWeight: -1,
            date: -1
          }
        },

        // 4. 分页
        {
          $skip: skip
        },
        {
          $limit: limit
        },

        // 5. 数据清洗 (去掉临时生成的 roleWeight 字段，去掉密码)
        {
          $project: {
            password: 0,
            roleWeight: 0
          }
        }
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
      const sortOptions = {
        [sortBy]: order
      };

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

// =================================================================
// 1. 用户注册 (Register)
// =================================================================
/**
 * @route   POST api/users
 * @desc    注册新用户
 * @access  Public
 * @body    { displayName, email(required), password, phone(optional) }
 */
router.post(
  "/",
  [
    // --- A. 基础字段校验 ---
    check("displayName", "Please provide a name")
    .not().isEmpty()
    .trim()
    .escape(), // 防 XSS

    check("email", "Please provide a valid email")
    .isEmail()
    .normalizeEmail(), // 标准化 (转小写等)

    check("password", "Password is required")
    .isLength({
      min: 8
    })
    .custom((value, {
      req
    }) => {
      if (value !== req.body.passwordConf) {
        throw new Error("Passwords do not match");
      }
      if (!PASSWORD_REGEX.test(value)) {
        throw new Error("Password must contain letters and numbers, min 8 chars");
      }
      return true;
    }),

    // --- B. 手机号校验 (严谨逻辑) ---
    // optional({ checkFalsy: true }): 允许 null, undefined, "" 通过校验
    // 如果有值，则必须通过 custom 正则校验
    check("phone", "Invalid phone format. (e.g., +8613800000000)")
    .optional({
      nullable: true,
      checkFalsy: true
    })
    .trim()
    .custom((value) => {
      if (!PHONE_REGEX.test(value)) {
        throw new Error("Phone number format is invalid");
      }
      return true;
    })
  ],
  async (req, res) => {
    // 1. 校验结果处理
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        errors: errors.array()
      });
    }

    const {
      displayName,
      email,
      password,
      phone
    } = req.body;

    try {
      // 2. 检查邮箱唯一性 (转小写查)
      let userByEmail = await User.findOne({
        email: email.toLowerCase()
      });
      if (userByEmail) {
        return res.status(400).json({
          message: "User already exists",
          message_cn: "此邮箱已被占用"
        });
      }

      // 3. 检查手机号唯一性 & 数据清洗
      // 🔥 核心：如果 phone 是空字符串 ""，必须转为 undefined
      // 这样 MongoDB 的 sparse 索引才不会报错，允许别人也不填手机号
      const cleanPhone = (phone && phone.trim() !== '') ? phone.trim() : undefined;

      if (cleanPhone) {
        const userByPhone = await User.findOne({
          phone: cleanPhone
        });
        if (userByPhone) {
          return res.status(400).json({
            message: "Phone number already in use",
            message_cn: "此手机号已被其他账号绑定"
          });
        }
      }

      // 4. 创建用户实例
      const newUser = new User({
        displayName,
        email: email.toLowerCase(),
        phone: cleanPhone, // 存入清洗后的手机号
        password, // 暂存明文，下一步加密
        date: getCreateTime(),
        vip: false
      });

      // 5. 密码加密
      const salt = await bcrypt.genSalt(10);
      newUser.password = await bcrypt.hash(password, salt);

      // 6. 落库保存
      await newUser.save();

      // 7. 生成 Token Payload (包含 phone)
      const payload = permissionService.buildUserPayload(newUser);

      const token = signToken(payload);
      await setToken(`auth:${token}`, token);

      // 8. 审计日志
      logOperation({
        operatorId: newUser.id,
        action: "SIGN_UP",
        target: `User Registered: ${newUser.email}`,
        details: {
          phone: cleanPhone
        },
        ip: req.ip,
        io: req.app.get('socketio')
      });

      // 9. 返回响应 (数据脱敏 + 动态权限)
      const userObj = newUser.toObject();
      delete userObj.password;
      delete userObj.__v;

      // 🔥 计算权限 (DB Role + Extra Permissions)
      userObj.permissions = permissionService.getUserMergedPermissions(newUser);

      res.status(201).json({
        token,
        user: userObj
      });

    } catch (error) {
      console.error("[Register Error]:", error);
      res.status(500).json({
        message: "Server internal error"
      });
    }
  }
);

// =================================================================
// 2. 用户登录 (Sign In)
// =================================================================
/**
 * @route   POST api/users/signin
 * @desc    用户登录 (支持 邮箱 或 手机号)
 * @access  Public
 * @body    { email: "输入账号(邮箱/手机)", password: "..." } 
 * ⚠️ 注意：为了兼容前端旧代码，接收参数名仍为 'email'，但后端作为 'inputAccount' 处理
 */
router.post(
  "/signin",
  [
    // 校验放宽：只要有值就行，不要用 isEmail 限制死了
    check("email", "Please enter your email or phone number").exists().not().isEmpty(),
    check("password", "Password is required").exists()
  ],
  async (req, res) => {
    // 1. 校验输入
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        errors: errors.array()
      });
    }

    // 🔥🔥🔥 核心：变量重命名 (Aliasing) 🔥🔥🔥
    // 彻底消除歧义：inputAccount 代表用户输入的任何账号字符串
    const {
      email: inputAccount,
      password
    } = req.body;

    try {
      // 2. 智能查询 (Dual Strategy)
      // 使用 $or 并行查找：要么匹配 email，要么匹配 phone
      const user = await User.findOne({
        $or: [{
            email: inputAccount.toLowerCase()
          }, // 尝试匹配邮箱 (转小写)
          {
            phone: inputAccount
          } // 尝试匹配手机号
        ]
      });

      // 3. 账号不存在
      if (!user) {
        return res.status(401).json({
          message: "Invalid credentials",
          message_cn: "账号不存在或密码错误" // 模糊报错，防止枚举
        });
      }

      // 4. 密码校验
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          message: "Invalid credentials",
          message_cn: "账号不存在或密码错误"
        });
      }

      // 5. 生成 Token Payload (包含 phone)
      const payload = permissionService.buildUserPayload(user);

      const token = signToken(payload);
      await setToken(`auth:${token}`, token);

      // 6. 记录日志 (区分登录方式)
      const loginMethod = inputAccount.includes('@') ? 'email' : 'phone';
      logOperation({
        operatorId: user.id,
        action: "SIGN_IN",
        target: `Login via ${loginMethod}`,
        details: {
          inputAccount
        },
        ip: req.ip,
        io: req.app.get('socketio')
      });

      // 7. 返回响应
      let userObj = user.toObject();
      delete userObj.password;
      delete userObj.__v;

      // 🔥 计算最终权限
      userObj.permissions = permissionService.getUserMergedPermissions(user);

      res.json({
        token,
        user: userObj
      });

    } catch (error) {
      console.error("[Login Error]:", error.message);
      res.status(500).json({
        message: "Server internal error"
      });
    }
  }
);

/**
 * @route   POST /api/users/logout
 * @desc    用户主动退出登录
 */
router.post("/logout", async (req, res) => {
  try {
    // 1. 从 req.user 拿到当前正在使用的 token (由 auth 中间件挂载)
    const currentToken = req.user.token;
    await userSession.del(currentToken);

    // 3. (可选) 清理 5 秒缓存，让该用户的状态在服务器内存也干净
    permissionService.clearUserCache(req.user.id);

    res.json({
      success: true,
      msg: "已成功安全退出"
    });
  } catch (err) {
    res.status(500).send("Logout Error");
  }
});

// 1. Token 生成逻辑
function signToken(payload) {
  return jwt.sign(payload, SECRET, {
    expiresIn: "30d"
  });
}

// 2. userSession 存储逻辑
function setToken(key, value) {
  return Promise.resolve(userSession.set(key, value, 'EX', 2592000));
}


// @route   PUT /api/users/password
router.put("/password", async (req, res) => {
  const {
    oldPassword,
    newPassword
  } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({
      message: "Please provide old and new passwords"
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      message: "New password must be at least 6 characters"
    });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({
      message: "User not found"
    });

    if (!user.password) {
      return res.status(400).json({
        message: "You use Google Login, no password to change."
      });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        message: "Invalid old password"
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({
      message: "Password updated successfully"
    });

  } catch (err) {
    console.error("Change password error:", err.message);
    res.status(500).send("Server Error");
  }
});

// @route   PUT /api/users/fitness-goal
router.put("/fitness-goal", async (req, res) => {
  const {
    goal,
    userId
  } = req.body;

  if (!['cut', 'bulk', 'maintain'].includes(goal)) {
    return res.status(400).json({
      msg: "无效的模式"
    });
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
  const {
    email,
    newPassword,
    secretKey
  } = req.body;

  if (!email || !newPassword || !secretKey) {
    return res.status(400).json({
      message: "请填写邮箱、新密码和超级暗号"
    });
  }

  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || "bananaboom-666";

  if (secretKey !== ADMIN_SECRET) {
    return res.status(403).json({
      message: "暗号错误！你不是自己人。"
    });
  }

  try {
    const user = await User.findOne({
      email
    });
    if (!user) {
      return res.status(404).json({
        message: "找不到这个邮箱的用户"
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    await user.save();
    // 🔥 修复：判空处理，防止未登录时 req.user 报错
    const operatorId = req.user ? req.user.id : user._id; // 如果没登录，就记录是用户自己重置的

    logOperation({
      operatorId: operatorId, // 注意：如果未登录调用此接口，req.user可能不存在，建议判空处理
      action: "RESET_BY_SECRET",
      target: `密码已通过暗号强制重置 [${email}]`,
      details: {},
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json({
      success: true,
      message: "密码已通过暗号强制重置！请直接登录。"
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// @route   PUT /api/users/grant-vip
router.put("/grant-vip", async (req, res) => {
  const {
    email,
    username
  } = req.body;

  if (!email && !username) {
    return res.status(400).json({
      message: "请提供目标用户的邮箱或用户名"
    });
  }

  try {
    let targetUser = null;
    if (email) {
      targetUser = await User.findOne({
        email
      });
    } else if (username) {
      targetUser = await User.findOne({
        displayName: username
      });
    }

    if (!targetUser) {
      return res.status(404).json({
        message: "找不到该用户"
      });
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
router.put("/revoke-vip", async (req, res) => {
  const {
    email,
    username
  } = req.body;
  if (!email && !username) {
    return res.status(400).json({
      message: "请提供目标用户的邮箱或用户名"
    });
  }

  try {
    const targetUser = await User.findOne({
      $or: [{
          email: email
        },
        {
          displayName: username
        }
      ]
    });

    if (!targetUser) {
      return res.status(404).json({
        message: "未找到该用户"
      });
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
    res.status(500).json({
      message: "Server Error"
    });
  }
});

// @route   PUT /api/users/:id
// @desc    修改个人资料 (名字、头像、身高、健身目标, 时区，barkUrl)
router.put("/:id", async (req, res) => {
  const {
    displayName,
    photoURL,
    height,
    fitnessGoal,
    barkUrl,
    timezone
  } = req.body;
  const userId = req.params.id;

  if (req.user.id !== userId) {
    return res.status(403).json({
      message: "你无权修改他人的资料"
    });
  }

  try {
    const user = await User.findById(userId).select('+barkUrl');

    if (!user) {
      return res.status(404).json({
        message: "用户不存在"
      });
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
      return res.json({
        success: true,
        message: "资料未变动",
        user
      });
    }

    // 🔥 .save() 触发 VIP/Role 同步钩子
    const updatedUser = await user.save();

    // 数据脱敏 + 权限注入
    const userObj = updatedUser.toObject();
    delete userObj.password;
    delete userObj.googleId;
    delete userObj.__v;
    // 🔥 重新计算权限 (因为角色可能变了)
    userObj.permissions = permissionService.getUserMergedPermissions(updatedUser);

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
      return res.status(400).json({
        message: "参数错误: " + error.message
      });
    }
    res.status(500).json({
      message: "修改失败，服务器错误"
    });
  }
});

// @route   PUT /api/users/:id/role
// @desc    修改用户角色 (权限管理)
router.put("/:id/role", async (req, res) => {
  const targetUserId = req.params.id;
  const {
    role: newRole
  } = req.body;

  const ALLOWED_ROLES = ['user', 'admin', 'super_admin', 'bot'];
  if (!ALLOWED_ROLES.includes(newRole)) {
    return res.status(400).json({
      msg: "无效的角色类型"
    });
  }

  try {
    const requester = await User.findById(req.user.id);
    if (!requester) return res.status(401).json({
      msg: "操作人不存在"
    });

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) return res.status(404).json({
      msg: "目标用户不存在"
    });

    // 权限逻辑
    if (requester.role === 'user') {
      return res.status(403).json({
        msg: "权限不足：普通用户无法修改角色"
      });
    }
    if (requester.role === 'admin') {
      if (newRole === 'super_admin') return res.status(403).json({
        msg: "权限不足：Admin 不能任命超级管理员"
      });
      if (targetUser.role === 'super_admin') return res.status(403).json({
        msg: "权限不足：Admin 无法修改超级管理员的账号"
      });
    }

    if (targetUser.role === newRole) {
      return res.status(400).json({
        msg: "该用户已经是这个角色了"
      });
    }

    targetUser.role = newRole;
    await targetUser.save(); // 触发 Hook
    // ============================================================
    // 🔥 核心改动 1：清理 5 秒短缓存
    // 确保该用户下一个请求进来时，auth 中间件必须从数据库读最新角色
    // ============================================================
    permissionService.clearUserCache(targetUserId);

    console.log(`👮 [Role Change] ${requester.displayName} changed ${targetUser.displayName} to ${newRole}`);

    // 🔥 返回带权限的用户对象
    const userObj = targetUser.toObject();
    delete userObj.password;
    userObj.permissions = permissionService.getUserMergedPermissions(targetUser);

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
  async (req, res) => {
    const userId = req.params.id;
    const {
      permissions
    } = req.body;

    if (!Array.isArray(permissions)) {
      return res.status(400).json({
        msg: "Permissions must be an array"
      });
    }

    try {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({
        msg: "User not found"
      });

      // 安全过滤
      const validPermissionKeys = Object.values(K);
      const cleanPermissions = permissions.filter(p => {
        const isValid = validPermissionKeys.includes(p);
        if (!isValid) console.warn(`⚠️ Warning: Ignoring invalid permission key: ${p}`);
        return isValid;
      });

      user.extraPermissions = cleanPermissions;
      await user.save();
      // ============================================================
      // 🔥 核心改动：清理 5 秒短缓存
      // 这样用户在前端点下“确定”后，下一个操作会立即拥有新权限
      // ============================================================
      permissionService.clearUserCache(userId);

      console.log(`👮 [Permission Grant] ${req.user.displayName} gave [${cleanPermissions}] to ${user.displayName}`);

      // 返回结果
      const userObj = user.toObject();
      delete userObj.password;
      delete userObj.googleId;
      delete userObj.__v;
      // 🔥 别忘了注入合并后的最终权限
      userObj.permissions = permissionService.getUserMergedPermissions(user);

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