import { Router } from 'express';
import Post from '../models/Post.js'; // 确保路径正确

const router = Router();

/**
 * @route   GET /api/tags
 * @desc    获取所有标签列表及其文章数量
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    const tags = await Post.aggregate([
      // 1. 🛡️ 安全过滤：只统计公开文章 (如果是管理员后台，可以去掉这行)
      { $match: { isPrivate: false } },

      // 2. 🧶 拆解数组：将 tags: ["Tech", "Love"] 拆成多条记录
      { $unwind: "$tags" },

      // 3. 📦 分组统计：按 tag 名字分组，统计出现次数
      {
        $group: {
          _id: "$tags", // 分组依据
          count: { $sum: 1 } // 计数器
        }
      },

      // 4. 🧹 排序：数量多的在前面，数量一样按字母排
      { $sort: { count: -1, _id: 1 } }
    ]);

    // 5. 格式化输出 (让前端更好用)
    // 原始结果: [{ _id: "Tech", count: 15 }, ...]
    // 转换后: [{ name: "Tech", count: 15 }, ...]
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