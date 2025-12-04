const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const Resume = require("../models/Resume");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");
const validate = require("../middleware/validate");

// ==========================================
// 1. 获取简历 (公开)
// ==========================================
// @route   GET api/resume
// @desc    获取唯一的简历数据
// @access  Public
router.get("/", async (req, res) => {
  try {
    // 既然是个人站，我们假设库里只有一条简历数据，直接取第一个
    const resume = await Resume.findOne();
    
    if (!resume) {
      // 如果还没数据（虽然我们seed过了），返回空对象或初始化一个默认的
      return res.status(404).json({ msg: "Resume not found" });
    }
    
    res.json(resume);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

router.use(auth, checkPrivate);

// ==========================================
// 更新简历 (PUT) - 严格校验
// /api/resume
// ==========================================
router.put(
  "/",
  [
    // 1. 校验 Basics (基础信息)
    // 如果传了 basics 对象，则检查里面的 email 是否合法
    body("basics.email").optional({ checkFalsy: true }).isEmail().withMessage("邮箱格式不正确"),
    body("basics.name_zh").optional().isString(),
    body("basics.name_en").optional().isString(),

    // 2. 校验 Education (数组)
    // 确保 education 是个数组
    body("education").optional().isArray().withMessage("教育经历必须是数组"),
    // 确保 education 数组里的每一项的 startDate 是字符串 (如果有的话)
    body("education.*.institution").optional().notEmpty().withMessage("学校名称不能为空"),
    
    // 3. 校验 Work (数组)
    body("work").optional().isArray().withMessage("工作经历必须是数组"),
    body("work.*.company_zh").optional().notEmpty().withMessage("公司中文名不能为空"),
    body("work.*.company_en").optional().notEmpty().withMessage("公司英文名不能为空"),
    // 校验 highlights 必须是数组
    body("work.*.highlights_zh").optional().isArray().withMessage("中文工作亮点必须是数组"),
    body("work.*.highlights_en").optional().isArray().withMessage("英文工作亮点必须是数组"),

    // 4. 校验 Skills (数组)
    body("skills").optional().isArray(),
    body("skills.*.keywords").optional().isArray().withMessage("技能关键词必须是数组"),

    validate
  ],
  async (req, res) => {
    try {
      // 这里的逻辑保持不变
      const resume = await Resume.findOneAndUpdate(
        {}, 
        { $set: req.body },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      res.json(resume);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

module.exports = router;