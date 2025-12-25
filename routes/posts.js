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
 * @param {Object} req - Express Request
 * @param {Object} res - Express Response
 */
const getLikes = async (req, res) => {
  try {
    const like = await Post.findOne({ _id: req.params.id }, { likes: 1 });
    res.json(like);
  } catch (error) {
    console.error('Get Likes Error:', error);
    // 保持原有逻辑，出错时不中断响应
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
    tags = tags
      .trim()
      .split(' ')
      .filter((t) => t);
  }

  // 2. 返回清洗后的数据
  return { name, info, author, content, isPrivate, tags, url, button };
};

/**
 * 获取文章列表核心逻辑 (支持分页、搜索、标签、私有过滤)
 * @param {Object} req - Express Request
 * @param {Object} res - Express Response
 * @param {Boolean} isPrivate - 是否查询私有文章
 */
const getPost = async (req, res, isPrivate) => {
  try {
    // 1. 参数解析
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // 2. 构建查询条件
    const query = { isPrivate };

    // 搜索逻辑 (匹配 标题 OR 内容)
    if (req.query.q) {
      const keyword = req.query.q;
      // 使用正则进行模糊匹配
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
        // 🔥 优化：明确按创建时间倒序排列 (最新的在前)
        .sort({ createdDate: -1 }) 
        .skip(skip)
        .limit(limit)
        // 🔥 安全策略：返回 User 信息，但强制排除密码字段
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
 * @desc    获取公开文章列表 (支持分页/搜索)
 * @access  Public
 */
router.get('/', async (req, res) => await getPost(req, res, false));

/**
 * @route   GET /api/posts/private/posts
 * @desc    获取私有文章列表 (仅管理员)
 * @access  Private (Auth + CheckPrivate)
 * ⚠️ 注意：此路由必须定义在 GET /:id 之前，防止被 ID 参数拦截
 */
router.get('/private/posts', async (req, res) => await getPost(req, res, true));

/**
 * @route   GET /api/posts/likes/:id
 * @desc    获取某篇文章的点赞数
 * @access  Public
 */
router.get('/likes/:id', async (req, res) => await getLikes(req, res));

/**
 * @route   GET /api/posts/:id
 * @desc    获取单篇文章详情
 * @access  Public
 */
router.get('/:id', async (req, res) => {
  try {
    // 🔥 核心修复：使用 findById 代替 find
    // find 返回的是数组 [{...}]，findById 返回的是对象 {...}
    // 这是详情页接口的标准写法
    const post = await Post.findById(req.params.id).populate('user', '-password');

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    res.json(post);
  } catch (error) {
    // 处理 ID 格式错误的情况
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
 * @access  Private
 */
router.post('/', async (req, res) => {
  try {
    const postData = formatPostData(req.body);

    const newPost = new Post({
      ...postData,
      likes: 0,
      user: req.user.id
      // createdDate 和 updatedDate 由 Schema 的 default: Date.now 自动处理
    });

    await newPost.save();

    // 审计日志
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
 * @access  Private
 */
router.put('/:id', async (req, res) => {
  try {
    const updateData = formatPostData(req.body);

    // ✅ 更新操作：显式刷新 updatedDate 为当前时间
    updateData.updatedDate = new Date();

    // 执行更新
    const updatedPost = await Post.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedPost) {
      return res.status(404).json({ msg: '文章不存在' });
    }

    // 审计日志
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
 * @desc    删除文章 (需要 SecretKey 校验私有文章)
 * @access  Private (Auth + CheckPrivate)
 */
router.delete('/:id', async (req, res) => {
  const { secretKey } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || 'orion';

  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    // 私有文章删除时的双重保险
    const wasPrivate = post.isPrivate;
    if (wasPrivate) {
      if (secretKey !== ADMIN_SECRET) {
        return res.status(403).json({ message: '暗号错误！删除私有日志需要超级权限。' });
      }
    }

    await Post.findByIdAndDelete(req.params.id);

    // 🔥 审计日志
    logOperation({
      operatorId: req.user.id,
      action: 'DELETE_POST',
      target: post.name,
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 删除后返回列表 (如果删的是私有，返回私有列表；否则返回公开列表)
    await getPost(req, res, wasPrivate);
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
 * @access  Public
 * @middleware likeLimiter - 包含限流保护
 */
router.post('/likes/:id/add', likeLimiter, async (req, res) => {
  try {
    // 🔥 timestamps: false 确保点赞不会更新 updatedDate
    await Post.updateOne(
      { _id: req.params.id }, 
      { $inc: { likes: 1 } },
      { timestamps: false } 
    );
    await getLikes(req, res);
  } catch (error) {
    console.error('Add Like Error:', error);
    // 错误不阻断前端交互
  }
});

/**
 * @route   POST /api/posts/likes/:id/remove
 * @desc    取消点赞 (-1)
 * @access  Public
 * @middleware likeLimiter - 包含限流保护
 */
router.post('/likes/:id/remove', likeLimiter, async (req, res) => {
  try {
    // 只有当 likes > 0 时才减 1，且不更新文章修改时间
    await Post.updateOne(
      { _id: req.params.id, likes: { $gt: 0 } },
      { $inc: { likes: -1 } },
      { timestamps: false } // 🔥 关键修复
    );
    await getLikes(req, res);
  } catch (error) {
    console.error('Remove Like Error:', error);
  }
});

export default router;