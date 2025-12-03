const express = require("express");
const router = express.Router();
const AuditLog = require("../models/AuditLog");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

// 全局鉴权：只有 VIP/管理员 才能看日志
router.use(auth, checkPrivate);

// GET /api/audit
// 参数示例: ?page=1&action=DELETE_POST&target=React&startDate=2023-01-01
router.get("/", async (req, res) => {
  try {
    // 1. 分页参数
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2. 筛选参数 (从 URL query 中解构出来)
    const { 
      action,       // 精确匹配
      target,       // 模糊搜索
      ip,           // 模糊搜索
      operator,     // 精确匹配 User ID
      startDate,    // 开始时间
      endDate       // 结束时间
    } = req.query;

    // 3. 构建 MongoDB 查询对象
    let query = {};

    // A. 操作类型 (精确匹配)
    // 比如前端下拉框选了 "LOGIN"，这里就只查登录日志
    if (action) {
      query.action = action;
    }

    // B. 操作对象描述 (模糊搜索 - Regex)
    // 比如搜 "删除"，能查到 "删除评论" 和 "删除文章"
    if (target) {
      query.target = { $regex: target, $options: "i" }; // 'i' 表示忽略大小写
    }

    // C. IP 地址 (模糊搜索)
    // 比如搜 "192.168"，能查到该网段所有操作
    if (ip) {
      query.ip = { $regex: ip, $options: "i" };
    }

    // D. 操作人 (精确匹配 UserID)
    // 比如点击某个人的头像，查看他所有的操作记录
    if (operator) {
      query.operator = operator;
    }

    // E. 时间范围筛选
    // 支持只传开始时间，或只传结束时间，或都传
    if (startDate || endDate) {
      query.createdDate = {};
      if (startDate) {
        query.createdDate.$gte = new Date(startDate); // 大于等于
      }
      if (endDate) {
        //以此日期的 23:59:59 结束，或者直接传入下一天的 00:00
        query.createdDate.$lte = new Date(endDate);   // 小于等于
      }
    }

    // 4. 执行查询 (并行查数据 + 查总数)
    const [logs, total] = await Promise.all([
      AuditLog.find(query) // 🔥 把构建好的 query 放进去
        .sort({ createdDate: -1 })
        .skip(skip)
        .limit(limit)
        // 关联查出操作人的信息 (带上 email 方便管理员确认身份)
        .populate("operator", "displayName photoURL email"), 
      
      AuditLog.countDocuments(query) // 🔥 统计总数时也要带上 query，否则分页会错
    ]);

    // 5. 返回结果
    res.json({
      data: logs,
      pagination: {
        currentPage: page,
        limit: limit,
        totalPages: Math.ceil(total / limit),
        totalPosts: total
      }
    });

  } catch (error) {
    console.error("Audit Log Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;