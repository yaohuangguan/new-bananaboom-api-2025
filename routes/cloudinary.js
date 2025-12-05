const express = require("express");
const router = express.Router();
const cloudinary = require("cloudinary").v2;
const auth = require("../middleware/auth");


// 1. 初始化配置 (从环境变量读取)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 🔥 全局鉴权：这些接口只有登录用户(auth) 且是 VIP(checkPrivate) 才能用
router.use(auth);

/**
 * @route   GET /api/cloudinary/config
 * @desc    获取前端初始化所需的公开信息
 */
router.get("/config", (req, res) => {
  res.json({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    // 注意：绝对不能返回 API Secret！
  });
});

/**
 * @route   GET /api/cloudinary/signature
 * @desc    生成上传签名 (这是前端安全上传的核心)
 * 前端拿到这个 timestamp 和 signature 后，就可以直接传图给 Cloudinary
 */
router.get("/signature", (req, res) => {
  const timestamp = Math.round(new Date().getTime() / 1000);

  // 生成签名
  // 你可以在 params 里加更多限制，比如 folder: 'blog-images'
  const signature = cloudinary.utils.api_sign_request(
    {
      timestamp: timestamp,
      // folder: "next-bananaboom", // 可选：指定上传文件夹
    },
    process.env.CLOUDINARY_API_SECRET
  );

  res.json({
    timestamp,
    signature
  });
});

/**
 * @route   GET /api/cloudinary/usage
 * @desc    获取账户用量信息 (比如用了多少存储空间)
 * 适合展示在你的私域 Dashboard 里
 */
router.get("/usage", async (req, res) => {
  try {
    // 使用 Admin API 查询
    const result = await cloudinary.api.usage();
    res.json(result);
  } catch (error) {
    console.error("Cloudinary usage error:", error);
    res.status(500).json({ message: "Failed to fetch Cloudinary usage" });
  }
});

/**
 * @route   GET /api/cloudinary/resources
 * @desc    (可选) 获取最近上传的图片列表
 */
router.get("/resources", async (req, res) => {
    try {
        const result = await cloudinary.api.resources({
            max_results: 20, // 最多返回20张
            direction: 'desc' // 最新的在前
        });
        res.json(result.resources);
    } catch (error) {
        console.error("Cloudinary resources error:", error);
        res.status(500).json({ message: "Failed to fetch images" });
    }
});

module.exports = router;