const express = require("express");
const router = express.Router();
const AuditLog = require("../models/AuditLog");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

// 全局鉴权：只有 VIP 才能看日志
router.use(auth, checkPrivate);

// GET /api/audit?page=1&limit=20
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AuditLog.find()
        .sort({ createdDate: -1 }) // 最新在前
        .skip(skip)
        .limit(limit)
        .populate("operator", "displayName photoURL"), // 把操作人的头像名字带出来
      
      AuditLog.countDocuments()
    ]);

    res.json({
      data: logs,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalPosts: total
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;