/**
 * @module routes/posts
 * @description 博客文章管理模块
 * 处理文章的 CRUD、点赞、权限控制及审计日志
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit'; // 🛡️ 引入限流中间件
const router = Router();

// 引入依赖
import Post from '../models/Post.js';
import { canReadPost } from '../utils/postAccess.js';
import logOperation from '../utils/audit.js'; // 审计日志工具

// =================================================================
// 🛡️ 安全配置 (Security Config)
// =================================================================

/**
 * 点赞接口限流器
 * 防止脚本恶意刷赞或高频点击
 * 策略：单 IP 每分钟限制 30 次请求
 */
const likeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟时间窗口
  max: 30, // 限制每个 IP 30 次请求
  message: {
    message: '❤️ 您的手速太快了，请休息一下再点赞吧！'
  },
  standardHeaders: true, // 返回 RateLimit-* 头信息
  legacyHeaders: false // 禁用 X-RateLimit-* 头信息
});

// 禁用缓存中间件，确保列表数据实时更新
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// =================================================================
// 🔧 辅助函数 (Controller Helpers)
// =================================================================

/**
 * 获取点赞数辅助函数
 */
const getLikes = async (req, res) => {
  try {
    const like = await Post.findOne({ _id: req.params.id }, { likes: 1 });
    res.json(like);
  } catch (error) {
    console.error('Get Likes Error:', error);
  }
};

/**
 * 🛠️ 数据清洗工具
 * 只保留 Model 中定义的有效字段
 */
const formatPostData = (body) => {
  let { name, info, author, content, isPrivate, tags, url, button } = body;

  // 1. 标签处理：字符串转数组 & 去空
  if (tags && typeof tags === 'string') {
    tags = tags.trim().split(' ').filter((t) => t);
  }

  return { name, info, author, content, isPrivate, tags, url, button };
};

/**
 * 获取文章列表核心逻辑 (支持分页、搜索、标签、私有过滤)
 */
const getPost = async (req, res, isPrivate) => {
  try {
    // 1. 参数解析
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // 2. 构建查询条件
    const query = { isPrivate };

    // 搜索逻辑
    if (req.query.q) {
      const keyword = req.query.q;
      query.$or = [
        { name: { $regex: keyword, $options: 'i' } }, 
        { content: { $regex: keyword, $options: 'i' } }
      ];
    }

    // 标签筛选
    if (req.query.tag) {
      query.tags = req.query.tag;
    }

    // 3. 并行查询 (数据 + 总数)
    const [posts, total] = await Promise.all([
      Post.find(query)
        // 🔥 修改：按 createdAt 倒序 (使用新字段名)
        .sort({ createdAt: -1 }) 
        .skip(skip)
        .limit(limit)
        .populate('user', '-password'),

      Post.countDocuments(query)
    ]);

    // 4. 返回标准分页结构
    return res.json({
      data: posts,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalPosts: total,
        perPage: limit
      }
    });
  } catch (error) {
    console.error('Get Post List Error:', error);
    res.status(500).send('Server Error when getting the post');
  }
};

// =================================================================
// 📖 读取类接口 (Read Routes)
// =================================================================

/**
 * @route   GET /api/posts
 * @desc    获取公开文章列表
 */
router.get('/', async (req, res) => await getPost(req, res, false));

/**
 * @route   GET /api/posts/private/posts
 * @desc    获取私有文章列表
 */
router.get('/private/posts', async (req, res) => await getPost(req, res, true));

/**
 * @route   GET /api/posts/likes/:id
 * @desc    获取某篇文章的点赞数
 */
router.get('/likes/:id', async (req, res) => await getLikes(req, res));

/**
 * @route   GET /api/posts/:id
 * @desc    获取单篇文章详情
 */
router.get('/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate('user', '-password');
    if (!post || !canReadPost(post, req.user)) {
      return res.status(404).json({ message: 'Post not found' });
    }
    res.json(post);
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(404).json({ message: 'Post not found' });
    }
    console.error('Get Single Post Error:', error);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// ✍️ 写入类接口 (Write Routes)
// =================================================================

/**
 * @route   POST /api/posts
 * @desc    发布新文章
 */
router.post('/', async (req, res) => {
  try {
    const postData = formatPostData(req.body);

    const newPost = new Post({
      ...postData,
      likes: 0,
      user: req.user.id
      // 🔥 移除：createdDate/updatedDate 赋值
      // Mongoose timestamps: true 会自动在 .save() 时生成 createdAt 和 updatedAt
    });

    await newPost.save();

    logOperation({
      operatorId: req.user.id,
      action: 'CREATE_POST',
      target: newPost.name,
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.status(201).json({
      success: true,
      data: newPost
    });
  } catch (error) {
    console.error('Create Post Error:', error.message);
    res.status(500).json({ msg: '发布文章失败' });
  }
});

/**
 * @route   PUT /api/posts/:id
 * @desc    更新文章
 */
router.put('/:id', async (req, res) => {
  try {
    const updateData = formatPostData(req.body);

    // 🔥 移除：手动更新 updatedDate
    // findByIdAndUpdate + timestamps: true 会自动更新 updatedAt 字段

    const updatedPost = await Post.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedPost) {
      return res.status(404).json({ msg: '文章不存在' });
    }

    logOperation({
      operatorId: req.user.id,
      action: 'UPDATE_POST',
      target: updatedPost.name,
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json({
      success: true,
      data: updatedPost
    });
  } catch (error) {
    console.error('Update Post Error:', error.message);
    if (error.kind === 'ObjectId') {
      return res.status(404).json({ msg: '文章不存在' });
    }
    res.status(500).json({ msg: '更新文章失败' });
  }
});

/**
 * @route   DELETE /api/posts/:id
 * @desc    删除文章
 */
router.delete('/:id', async (req, res) => {
  const { secretKey } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || 'orion';

  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    if (post.isPrivate && secretKey !== ADMIN_SECRET) {
      return res.status(403).json({ message: '暗号错误！删除私有日志需要超级权限。' });
    }

    await Post.findByIdAndDelete(req.params.id);

    logOperation({
      operatorId: req.user.id,
      action: 'DELETE_POST',
      target: post.name,
      ip: req.ip,
      io: req.app.get('socketio')
    });

    await getPost(req, res, post.isPrivate);
  } catch (error) {
    console.error('Delete Post Error:', error);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 👍 点赞互动接口 (Interaction Routes)
// =================================================================

/**
 * @route   POST /api/posts/likes/:id/add
 * @desc    点赞 (+1)
 */
router.post('/likes/:id/add', likeLimiter, async (req, res) => {
  try {
    // 🔥 timestamps: false 确保点赞不会更新 updatedAt
    // 这是你最关心的功能：点赞不应该让文章“顶”到最前面
    await Post.updateOne(
      { _id: req.params.id }, 
      { $inc: { likes: 1 } },
      { timestamps: false } 
    );
    await getLikes(req, res);
  } catch (error) {
    console.error('Add Like Error:', error);
  }
});

/**
 * @route   POST /api/posts/likes/:id/remove
 * @desc    取消点赞 (-1)
 */
router.post('/likes/:id/remove', likeLimiter, async (req, res) => {
  try {
    await Post.updateOne(
      { _id: req.params.id, likes: { $gt: 0 } },
      { $inc: { likes: -1 } },
      { timestamps: false }
    );
    await getLikes(req, res);
  } catch (error) {
    console.error('Remove Like Error:', error);
  }
});

export default router;