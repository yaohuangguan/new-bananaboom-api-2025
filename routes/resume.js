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

// ==========================================
// 5. 获取所有有简历的账号列表
// ==========================================
// @route   GET api/resumes/users
// @desc    获取拥有简历的账号用户名列表
// @access  Public
router.get('/users', async (req, res) => {
  try {
    const users = await Resume.distinct('user');
    res.json(users);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 6. 导出 ATS 兼容可选文本 PDF (Puppeteer 单页长图/A4适应)
// ==========================================
// @route   GET api/resumes/export-pdf
// @desc    使用无头浏览器渲染无断页单页矢量 PDF
// @access  Public
router.get('/export-pdf', async (req, res) => {
  try {
    const targetSlug = req.query.user || req.query.slug || 'sam';
    const lang = req.query.lang || 'zh';

    let puppeteer;
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch (e) {
      return res.status(500).json({
        msg: 'Puppeteer is not installed on backend. Please run `npm install puppeteer`.'
      });
    }

    let launchOptions = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    let browser;
    try {
      // 1. 尝试启动 Puppeteer 自带的 Chromium
      browser = await puppeteer.launch(launchOptions);
    } catch (err1) {
      try {
        // 2. 尝试备选：启动系统安装的 Google Chrome
        browser = await puppeteer.launch({ ...launchOptions, channel: 'chrome' });
      } catch (err2) {
        return res.status(500).json({
          msg: 'Puppeteer 找不到 Chrome 浏览器二进制文件。请在终端运行: npx puppeteer browsers install chrome'
        });
      }
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 2 });

    let frontendHost = process.env.FRONTEND_URL;
    if (req.headers.referer) {
      try {
        const origin = new URL(req.headers.referer).origin;
        // 如果后端部署在云端 (Cloud Run)，而请求来自本地 localhost，需优先使用环境变量中的线上前端地址
        if (!origin.includes('localhost') || !process.env.FRONTEND_URL) {
          frontendHost = origin;
        }
      } catch (e) {}
    }
    if (!frontendHost) {
      frontendHost = 'http://localhost:5173';
    }

    const targetUrl = `${frontendHost}/profile?tab=resume&user=${targetSlug}&lang=${lang}&print=true`;

    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // 🔥 核心 DOM 纯化隔离 + 动态单页高度计算（保证 100% 单页输出，绝不发生跨页切字/断裂）
    const elementHeightPx = await page.evaluate(() => {
      const paper = document.getElementById('resume-paper-sheet') || document.querySelector('.resume-paper-sheet');
      if (paper) {
        document.body.innerHTML = paper.outerHTML;
        document.body.style.background = '#ffffff';
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        return paper.offsetHeight || document.body.scrollHeight;
      }
      return document.body.scrollHeight;
    });

    // 计算精确定高，保持标准 A4 比例宽度 (210mm)，高度根据实际内容自适应展高（无断页单页 PDF）
    const pageHeightMm = Math.max(297, Math.ceil((elementHeightPx * 210) / 794) + 12);

    const pdfBuffer = await page.pdf({
      width: '230mm',
      height: `${pageHeightMm}mm`,
      printBackground: true,
      margin: { top: '8mm', right: '4mm', bottom: '8mm', left: '6mm' }
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Resume_${targetSlug}_${lang}.pdf"`,
      'Content-Length': pdfBuffer.length
    });

    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF Generation Error:', err.message);
    res.status(500).send('Failed to generate PDF: ' + err.message);
  }
});

export default router;
