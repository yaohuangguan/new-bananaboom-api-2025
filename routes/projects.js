import { Router } from 'express';
const router = Router();
import { body, param } from 'express-validator'; // 引入校验工具
import Project from '../models/Project.js';
import validate from '../middleware/validate.js'; // 引入刚才写的通用校验中间件
import {
  previewGithubPortfolioImport,
  generateCloudflarePortfolioCover
} from '../services/portfolioImportService.js';

router.post(
  '/import-github/preview',
  [
    body('repoUrl')
      .isURL({ protocols: ['https'], require_protocol: true })
      .withMessage('请输入有效的 GitHub HTTPS 仓库地址'),
    validate
  ],
  async (req, res) => {
    try {
      const preview = await previewGithubPortfolioImport(req.body.repoUrl);
      res.json(preview);
    } catch (error) {
      console.error('[Portfolio Import]', error.message);
      const status = /Invalid GitHub|Only github\.com|must include owner|Repository not found/.test(
        error.message
      )
        ? 400
        : 500;
      res.status(status).json({ msg: error.message || 'Failed to import GitHub repository' });
    }
  }
);

router.post(
  '/import-github/generate-cover',
  [
    body('title_en').optional({ checkFalsy: true }).isString(),
    body('title_zh').optional({ checkFalsy: true }).isString(),
    body('summary_en').optional({ checkFalsy: true }).isString(),
    body('summary_zh').optional({ checkFalsy: true }).isString(),
    body('techStack').optional().isArray(),
    body('categories').optional().isArray(),
    body('category').optional().isIn(['web', 'fullstack', 'mobile', 'tools']),
    validate
  ],
  async (req, res) => {
    try {
      const cover = await generateCloudflarePortfolioCover(req.body);
      res.json(cover);
    } catch (error) {
      console.error('[Portfolio Cover]', error.message);
      const status = error.code === 'CLOUDFLARE_AI_NOT_CONFIGURED' ? 503 : 500;
      res.status(status).json({ msg: error.message || 'Failed to generate project cover' });
    }
  }
);

// ==========================================
// 1. 获取项目列表 (无需校验，因为没有参数)
// ==========================================
router.get('/', async (req, res) => {
  try {
    const projects = await Project.find({ isVisible: true }).sort({ order: -1, createdAt: -1 });
    res.json(projects);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/:id', [param('id').isMongoId().withMessage('无效的项目ID'), validate], async (req, res) => {
  // ... 逻辑不变
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ msg: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 创建新项目 (POST)
// ==========================================
router.post(
  '/',
  [
    // --- 校验规则开始 ---
    body('title_zh').notEmpty().withMessage('中文标题不能为空'),
    body('title_en').notEmpty().withMessage('英文标题不能为空'),

    body('demoUrl').optional({ checkFalsy: true }).isURL().withMessage('演示链接必须是有效的 URL'),
    body('repoUrl').optional({ checkFalsy: true }).isURL().withMessage('仓库链接必须是有效的 URL'),
    body('coverImage')
      .optional({ checkFalsy: true })
      .custom((value) => /^uploads\/\S+$/.test(value) || /^https?:\/\//i.test(value))
      .withMessage('封面图必须是有效的 URL 或 R2 key'),

    body('order').optional().isInt().withMessage('排序权重必须是整数'),
    body('isVisible').optional().isBoolean().withMessage('可见性必须是布尔值'),
    body('techStack').optional().isArray().withMessage('技术栈必须是数组'),
    body('category')
      .optional()
      .isIn(['web', 'fullstack', 'mobile', 'tools'])
      .withMessage('项目分类必须是 web、fullstack、mobile 或 tools'),
    body('categories').optional().isArray().withMessage('项目分类必须是数组'),
    body('categories.*')
      .optional()
      .isIn(['web', 'fullstack', 'mobile', 'tools'])
      .withMessage('项目分类包含不支持的值'),
    // --- 校验规则结束 ---

    validate // 挂载校验处理函数
  ],
  async (req, res) => {
    try {
      if (Array.isArray(req.body.categories) && req.body.categories.length > 0) {
        req.body.category = req.body.categories[0];
      }
      const newProject = new Project(req.body);
      const project = await newProject.save();
      res.json(project);
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  }
);

// ==========================================
// 3. 修改项目 (PUT)
// ==========================================
router.put(
  '/:id',
  [
    param('id').isMongoId().withMessage('无效的项目ID'),

    // PUT 更新时，字段通常是选填的，但如果填了就必须合法
    body('title_zh').optional().notEmpty().withMessage('中文标题不能为空'),
    body('title_en').optional().notEmpty().withMessage('英文标题不能为空'),
    body('demoUrl').optional({ checkFalsy: true }).isURL().withMessage('演示链接格式错误'),
    body('order').optional().isInt(),
    body('techStack').optional().isArray(),
    body('category').optional().isIn(['web', 'fullstack', 'mobile', 'tools']),
    body('categories').optional().isArray(),
    body('categories.*').optional().isIn(['web', 'fullstack', 'mobile', 'tools']),

    validate
  ],
  async (req, res) => {
    try {
      if (Array.isArray(req.body.categories) && req.body.categories.length > 0) {
        req.body.category = req.body.categories[0];
      }
      const project = await Project.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
      if (!project) return res.status(404).json({ msg: 'Project not found' });
      res.json(project);
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  }
);

// ==========================================
// 4. 删除项目 (DELETE)
// ==========================================
router.delete('/:id', [param('id').isMongoId().withMessage('无效的项目ID'), validate], async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ msg: 'Project not found' });

    await project.deleteOne();
    res.json({ msg: 'Project removed' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

export default router;
