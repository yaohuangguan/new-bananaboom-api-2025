const express = require("express");
const router = express.Router();
const Homepage = require("../models/Homepage");
const Project = require("../models/Project");
const Log = require("../models/Log");

// 🔥 引入限流中间件
const rateLimit = require("express-rate-limit");

// ==========================================
// 🛡️ 配置限流器 (Anti-Brushing Strategy)
// ==========================================

// 策略 1: 严格模式 (用于点赞)
// 规则: 1分钟窗口期内，单 IP 最多请求 10 次
const likeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 10, // 最大次数
  standardHeaders: true, // 返回 RateLimit-* 头信息
  legacyHeaders: false, // 禁用 X-RateLimit-* 头信息
  message: {
    message: "点赞太频繁了，请稍作休息再试！(Rate limit exceeded)"
  },
  // 关键：如果你的应用部署在 Nginx/Vercel/Heroku 后，需要信任代理 IP
  // 否则所有请求都会被识别为同一个 IP (负载均衡器的 IP)
  // keyGenerator: (req) => req.ip // 默认就是用 IP，通常不需要改，但在 app.js 里要设置 app.set('trust proxy', 1)
});

// 策略 2: 宽松模式 (用于读取数据)
// 规则: 1分钟窗口期内，单 IP 最多请求 60 次
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    message: "请求过于频繁，请稍后再试。"
  }
});

// ==========================================
// 1. 首页相关接口
// ==========================================

/**
 * @route   GET /api/homepage
 * @desc    获取首页完整数据
 * @access  Public
 */
// ✅ 应用宽松限流
router.get("/", readLimiter, async (req, res) => {
  try {
    const response = await Homepage.find().lean();
    res.status(200).json(response);
  } catch (error) {
    console.error("Fetch homepage error:", error);
    res.status(500).json({ message: "服务器内部错误" });
  }
});

/**
 * @route   GET /api/homepage/likes
 * @desc    单独获取点赞数据
 * @access  Public
 */
router.get("/likes", readLimiter, async (req, res) => {
  try {
    const response = await Homepage.find({}, { likes: 1 }).lean();
    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/homepage/likes/:id/add
 * @desc    点赞 (+1)
 * @access  Public (每个人都能点)
 */
// ✅ 🔥 应用严格限流 (防刷核心)
router.post("/likes/:id/add", likeLimiter, async (req, res) => {
  try {
    // 使用原子操作 $inc 确保并发安全
    const updatedDoc = await Homepage.findByIdAndUpdate(
      req.params.id,
      { $inc: { likes: 1 } },
      { new: true, select: "likes" } 
    );

    if (!updatedDoc) {
      return res.status(404).json({ message: "未找到对应的首页记录" });
    }

    res.status(200).json(updatedDoc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/homepage/likes/:id/remove
 * @desc    取消点赞 (-1)
 * @access  Public
 */
// ✅ 应用严格限流
router.post("/likes/:id/remove", likeLimiter, async (req, res) => {
  try {
    const updatedDoc = await Homepage.findByIdAndUpdate(
      req.params.id,
      { $inc: { likes: -1 } },
      { new: true, select: "likes" }
    );

    if (!updatedDoc) {
      return res.status(404).json({ message: "未找到对应的首页记录" });
    }

    res.status(200).json(updatedDoc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==========================================
// 2. 项目与日志接口 (静态内容)
// ==========================================

/**
 * @route   GET /api/homepage/projects
 * @desc    获取项目列表
 * @access  Public
 */
router.get("/projects", readLimiter, async (_req, res) => {
  try {
    const response = await Project.find().lean();
    // 静态内容缓存 1 小时
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/homepage/logs
 * @desc    获取更新日志
 * @access  Public
 */
router.get("/logs", readLimiter, async (_req, res) => {
  try {
    const response = await Log.find().sort({ version: 1 }).lean();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;