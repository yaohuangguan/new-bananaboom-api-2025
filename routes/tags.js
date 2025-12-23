import { Router } from 'express';
import Post from '../models/Post.js';
import auth from '../middleware/auth.js'; // 1. 引入你的 Soft Auth 中间件

const router = Router();

/**
 * @route   GET /api/tags
 * @desc    获取标签云 (支持权限控制)
 * @access  Public / Private
 * @param   type (query): 'public' (默认) | 'private' | 'all'
 */
router.get('/', auth, async (req, res) => {
  try {
    // --- 1. 构建查询条件 ($match) ---
    let matchStage = { isPrivate: false }; // 默认：只查公开

    // 只有登录用户 (req.user 存在) 才有资格看私密数据
    if (req.user) {
      const type = req.query.type;

      if (type === 'all') {
        // 查看全部 (公开 + 私密)
        matchStage = {}; 
      } else if (type === 'private') {
        // 只看私密
        matchStage = { isPrivate: true };
      } 
      // 如果是 'public' 或没传参数，保持默认 { isPrivate: false }
    }

    // --- 2. 执行聚合查询 ---
    const tags = await Post.aggregate([
      // 步骤 1: 筛选文章 (根据权限和参数动态决定)
      { $match: matchStage },

      // 步骤 2: 拆分 tags 数组 (一篇文章多个tag，拆成多行)
      { $unwind: "$tags" },

      // 步骤 3: 按照 tag 名字分组并计数
      {
        $group: {
          _id: "$tags", 
          count: { $sum: 1 }
        }
      },

      // 步骤 4: 排序 (数量倒序 -> 名字正序)
      { $sort: { count: -1, _id: 1 } }
    ]);

    // --- 3. 格式化输出 ---
    const formattedTags = tags.map(tag => ({
      name: tag._id,
      count: tag.count
    }));

    res.json(formattedTags);

  } catch (error) {
    console.error('Get Tags Error:', error);
    res.status(500).json({ msg: '获取标签列表失败' });
  }
});

export default router;