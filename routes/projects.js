const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator"); // 引入校验工具
const Project = require("../models/Project");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");
const validate = require("../middleware/validate"); // 引入刚才写的通用校验中间件

// ==========================================
// 1. 获取项目列表 (无需校验，因为没有参数)
// ==========================================
router.get("/", async (req, res) => {
  try {
    const projects = await Project.find({ isVisible: true })
      .sort({ order: -1, createdAt: -1 });
    res.json(projects);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

router.get("/:id", [
    param("id").isMongoId().withMessage("无效的项目ID"),
    validate
], async (req, res) => {
    // ... 逻辑不变
    try {
        const project = await Project.findById(req.params.id);
        if (!project) return res.status(404).json({ msg: "Project not found" });
        res.json(project);
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

// ------------------------------------------
// 以下接口需要鉴权 + 严格校验
// ------------------------------------------
router.use(auth, checkPrivate);

// ==========================================
// 2. 创建新项目 (POST)
// ==========================================
router.post(
  "/",
  [
    // --- 校验规则开始 ---
    body("title_zh").notEmpty().withMessage("中文标题不能为空"),
    body("title_en").notEmpty().withMessage("英文标题不能为空"),
    
    body("demoUrl").optional({ checkFalsy: true }).isURL().withMessage("演示链接必须是有效的 URL"),
    body("repoUrl").optional({ checkFalsy: true }).isURL().withMessage("仓库链接必须是有效的 URL"),
    body("coverImage").optional({ checkFalsy: true }).isURL().withMessage("封面图必须是有效的 URL"),
    
    body("order").optional().isInt().withMessage("排序权重必须是整数"),
    body("isVisible").optional().isBoolean().withMessage("可见性必须是布尔值"),
    body("techStack").optional().isArray().withMessage("技术栈必须是数组"),
    // --- 校验规则结束 ---
    
    validate // 挂载校验处理函数
  ],
  async (req, res) => {
    try {
      const newProject = new Project(req.body);
      const project = await newProject.save();
      res.json(project);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

// ==========================================
// 3. 修改项目 (PUT)
// ==========================================
router.put(
  "/:id",
  [
    param("id").isMongoId().withMessage("无效的项目ID"),
    
    // PUT 更新时，字段通常是选填的，但如果填了就必须合法
    body("title_zh").optional().notEmpty().withMessage("中文标题不能为空"),
    body("title_en").optional().notEmpty().withMessage("英文标题不能为空"),
    body("demoUrl").optional({ checkFalsy: true }).isURL().withMessage("演示链接格式错误"),
    body("order").optional().isInt(),
    body("techStack").optional().isArray(),
    
    validate
  ],
  async (req, res) => {
    try {
      const project = await Project.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true }
      );
      if (!project) return res.status(404).json({ msg: "Project not found" });
      res.json(project);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

// ==========================================
// 4. 删除项目 (DELETE)
// ==========================================
router.delete(
  "/:id",
  [
    param("id").isMongoId().withMessage("无效的项目ID"),
    validate
  ],
  async (req, res) => {
    try {
      const project = await Project.findById(req.params.id);
      if (!project) return res.status(404).json({ msg: "Project not found" });

      await project.deleteOne();
      res.json({ msg: "Project removed" });
    } catch (err) {
      res.status(500).send("Server Error");
    }
  }
);

module.exports = router;