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
 * 参考响应 {
    "plan": "Free",
    "last_updated": "2025-12-18",
    "date_requested": "2025-12-19T00:00:00Z",
    "transformations": {
        "usage": 36,
        "credits_usage": 0.04,
        "breakdown": {
            "transformation": 26
        }
    },
    "objects": {
        "usage": 94
    },
    "bandwidth": {
        "usage": 317387882,
        "credits_usage": 0.3
    },
    "storage": {
        "usage": 192041533,
        "credits_usage": 0.18
    },
    "impressions": {
        "usage": 558,
        "credits_usage": 0
    },
    "seconds_delivered": {
        "usage": 0,
        "credits_usage": 0
    },
    "credits": {
        "usage": 0.52,
        "limit": 25,
        "used_percent": 2.08
    },
    "resources": 94,
    "derived_resources": 0,
    "requests": 558,
    "media_limits": {
        "image_max_size_bytes": 10485760,
        "video_max_size_bytes": 104857600,
        "raw_max_size_bytes": 10485760,
        "image_max_px": 25000000,
        "asset_max_total_px": 50000000
    },
    "rate_limit_allowed": 500,
    "rate_limit_reset_at": "2025-12-19T16:00:00.000Z",
    "rate_limit_remaining": 497
}
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
 * @desc    获取图片列表
 * @return  Array<Object>  (直接返回数组，保持前端零修改)
 */
router.get("/resources", async (req, res) => {
  try {
      // 1. 调用 Cloudinary API
      const result = await cloudinary.api.resources({
          max_results: 20,   // 限制返回数量
          direction: 'desc', // 最新的在前
          resource_type: 'image',
          type: 'upload'
      });

      // 2. 🔥 关键点：只提取 resources 数组直接返回
      // Cloudinary 返回的是 { resources: [...], next_cursor: "..." }
      // 我们直接 res.json(数组)，这样前端拿到的就是 [ {asset_id...}, {asset_id...} ]
      res.json(result.resources);

  } catch (error) {
      console.error("Cloudinary error:", error);
      // 出错时最好也保持简单的 JSON 结构，或者返回空数组防止前端 .map 报错
      res.status(500).json([]); 
  }
});

module.exports = router;