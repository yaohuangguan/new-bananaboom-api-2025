const express = require("express");
const router = express.Router();
const { body } = require("express-validator"); // 引入校验规则
const Resume = require("../models/Resume");

const validate = require("../middleware/validate"); // 你的通用校验中间件

// ==========================================
// 1. 获取简历 (公开接口)
// ==========================================
// @route   GET api/resumes
// @desc    获取简历数据
// @param   user (可选): "sam" | "jenny"。默认 "sam"
// @access  Public
router.get("/", async (req, res) => {
  try {
    // 🔥 核心逻辑：前端不传参默认找 "sam"
    const targetSlug = req.query.user || "sam";

    const resume = await Resume.findOne({ slug: targetSlug });
    
    if (!resume) {
      return res.status(404).json({ msg: `Resume for user '${targetSlug}' not found` });
    }
    
    res.json(resume);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});


// ==========================================
// 2. 更新简历 (管理接口)
// ==========================================
// @route   PUT api/resumes
// @desc    更新指定用户的简历
// @param   user (可选): 要更新谁？默认 "sam"
// @access  Private
router.put(
  "/",
  [
    // --- 严格参数校验 ---
    
    // 1. 基础信息校验
    body("basics.email").optional({ checkFalsy: true }).isEmail().withMessage("邮箱格式不正确"),
    body("basics.name_zh").optional().isString(),
    body("basics.name_en").optional().isString(),

    // 2. 教育经历校验 (确保是数组)
    body("education").optional().isArray().withMessage("教育经历必须是数组"),
    body("education.*.institution").optional().notEmpty().withMessage("学校名称不能为空"),
    
    // 3. 工作经历校验
    body("work").optional().isArray().withMessage("工作经历必须是数组"),
    body("work.*.company_zh").optional().notEmpty().withMessage("公司中文名不能为空"),
    
    // 4. 技能与语言
    body("skills").optional().isArray(),
    body("languages").optional().isArray(),

    // 挂载校验处理函数
    validate
  ],
  async (req, res) => {
    try {
      // 🔥 核心逻辑：确定要更新谁的简历
      // 如果前端想更新 Jenny 的，必须发 PUT /api/resume?user=jenny
      const targetSlug = req.query.user || "sam";

      // 执行更新
      // $set: req.body 会智能合并。
      // 注意：对于数组字段（如 work），Mongoose 会直接覆盖整个数组（符合前端表单提交习惯）
      const resume = await Resume.findOneAndUpdate(
        { slug: targetSlug }, 
        { $set: req.body },
        { new: true, upsert: true, setDefaultsOnInsert: true } // 如果不存在则创建
      );

      // 如果是第一次创建，且没传 slug，强制补上 slug 防止数据错乱
      if (!resume.slug) {
          resume.slug = targetSlug;
          await resume.save();
      }

      console.log(`✅ Updated resume for: ${targetSlug}`);
      res.json(resume);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

module.exports = router;