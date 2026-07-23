import { Router } from 'express';
const router = Router();
import { body } from 'express-validator'; // 引入校验规则
import Resume from '../models/Resume.js';

import validate from '../middleware/validate.js'; // 你的通用校验中间件

// ==========================================
// 1. 获取简历列表 (公开接口)
// ==========================================
// @route   GET api/resumes/list
// @desc    获取指定用户的所有简历版本列表
// @param   user (可选): "sam" | "jenny"。默认 "sam"
// @access  Public
router.get('/list', async (req, res) => {
  try {
    const targetUser = req.query.user || 'sam';
    const resumes = await Resume.find({ user: targetUser }, 'slug title user createdAt').sort({ createdAt: 1 });
    res.json(resumes);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 获取简历 (公开接口)
// ==========================================
// @route   GET api/resumes
// @desc    获取指定版本的简历数据
// @param   user (可选): 简历 slug，如 "sam" | "sam-parttime"。默认 "sam"
// @access  Public
router.get('/', async (req, res) => {
  try {
    const targetSlug = req.query.user || 'sam';

    const resume = await Resume.findOne({ slug: targetSlug });

    if (!resume) {
      return res.status(404).json({ msg: `Resume for user '${targetSlug}' not found` });
    }

    res.json(resume);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 3. 更新简历 (管理接口)
// ==========================================
// @route   PUT api/resumes
// @desc    更新/创建指定版本的简历
// @param   user (可选): 简历 slug，如 "sam" | "sam-parttime"。默认 "sam"
// @access  Private
router.put(
  '/',
  [
    // --- 严格参数校验 ---

    // 1. 基础信息校验
    body('basics.email').optional({ checkFalsy: true }).isEmail().withMessage('邮箱格式不正确'),
    body('basics.name_zh').optional().isString(),
    body('basics.name_en').optional().isString(),

    // 2. 教育经历校验 (确保是数组)
    body('education').optional().isArray().withMessage('教育经历必须是数组'),
    body('education.*.institution').optional().notEmpty().withMessage('学校名称不能为空'),

    // 3. 工作经历校验
    body('work').optional().isArray().withMessage('工作经历必须是数组'),
    body('work.*.company_zh').optional().notEmpty().withMessage('公司中文名不能为空'),

    // 4. 技能与语言
    body('skills').optional().isArray(),
    body('languages').optional().isArray(),

    // 挂载校验处理函数
    validate
  ],
  async (req, res) => {
    try {
      const targetSlug = req.query.user || 'sam';

      // 执行更新
      const resume = await Resume.findOneAndUpdate(
        { slug: targetSlug },
        { $set: req.body },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      let needsSave = false;
      if (!resume.slug) {
        resume.slug = targetSlug;
        needsSave = true;
      }
      if (!resume.user) {
        const parts = targetSlug.split('-');
        resume.user = parts[0] || 'sam';
        needsSave = true;
      }
      if (req.body.title && resume.title !== req.body.title) {
        resume.title = req.body.title;
        needsSave = true;
      }

      if (needsSave) {
        await resume.save();
      }

      console.log(`✅ Updated resume for: ${targetSlug}`);
      res.json(resume);
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  }
);

// ==========================================
// 4. 删除简历 (管理接口)
// ==========================================
// @route   DELETE api/resumes
// @desc    删除指定简历版本
// @param   user (可选): 简历 slug，如 "sam-parttime"。默认 "sam"
// @access  Private
router.delete('/', async (req, res) => {
  try {
    const targetSlug = req.query.user || 'sam';
    if (targetSlug === 'sam' || targetSlug === 'jenny') {
      return res.status(400).json({ msg: 'Cannot delete the main resume version' });
    }

    const resume = await Resume.findOneAndDelete({ slug: targetSlug });
    if (!resume) {
      return res.status(404).json({ msg: `Resume for slug '${targetSlug}' not found` });
    }

    console.log(`✅ Deleted resume: ${targetSlug}`);
    res.json({ msg: 'Resume deleted successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

export default router;
