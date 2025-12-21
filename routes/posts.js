/**
 * @module routes/posts
 * @description 博客文章管理模块
 * 处理文章的 CRUD、点赞、权限控制及审计日志
 */

const express = require("express");
const router = express.Router();

// 引入依赖
const Post = require("../models/Post");
const getCreateTime = require("../utils");
const logOperation = require("../utils/audit"); // 审计日志工具


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
    console.error("Get Likes Error:", error);
    // 保持原有逻辑，出错时不中断响应，但建议加上 res.status(500)
  }
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
        .sort({ createdDate: -1 })
        .skip(skip)
        .limit(limit)
        // 🔥 关键安全策略：返回 User 信息，但强制排除密码字段
        .populate("user", "-password"), 
      
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
    console.error("Get Post List Error:", error);
    res.status(500).send("Server Error when getting the post");
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
router.get("/", async (req, res) => await getPost(req, res, false));

/**
 * @route   GET /api/posts/private/posts
 * @desc    获取私有文章列表 (仅管理员)
 * @access  Private (Auth + CheckPrivate)
 * ⚠️ 注意：此路由必须定义在 GET /:id 之前，防止被 ID 参数拦截
 */
router.get("/private/posts", async (req, res) => await getPost(req, res, true));

/**
 * @route   GET /api/posts/likes/:id
 * @desc    获取某篇文章的点赞数
 * @access  Public
 */
router.get("/likes/:id", async (req, res) => await getLikes(req, res));

/**
 * @route   GET /api/posts/:id
 * @desc    获取单篇文章详情
 * @access  Public
 */
router.get("/:id", async (req, res) => {
  try {
    // 🔥 安全策略：Populate 时排除 password
    const response = await Post.find({ _id: req.params.id }).populate("user", "-password");
    
    // 设置缓存策略 (1小时)
    res.setHeader("Cache-Control", "max-age=3600");
    res.json(response);
  } catch (error) {
    res.status(404).json({ message: "Not found the posts" });
  }
});

// =================================================================
// ✍️ 写入类接口 (Write Routes)
// =================================================================

/**
 * @route   POST /api/posts
 * @desc    发布新文章
 * @access  Private (Auth + CheckPrivate)
 */
router.post("/", async (req, res) => {
  let { name, info, author, content, code, code2, isPrivate, codeGroup, tags } = req.body;
  
  try {
    // 数据预处理
    const createdDate = getCreateTime();
    if (tags && typeof tags === 'string') tags = tags.trim().split(" ");
    if (Array.isArray(code)) code = code.join('\n'); 
    if (Array.isArray(code2)) code2 = code2.join('\n');

    const newPost = new Post({
      name, info, author, createdDate, likes: 0, tags, content, code, code2, codeGroup, isPrivate,
      user: req.user.id
    });

    // 🔥 审计日志 & Socket 推送
    logOperation({
      operatorId: req.user.id,
      action: "CREATE_POST",
      target: newPost.name,
      ip: req.ip,
      io: req.app.get('socketio')
    });

    await newPost.save();
    
    // 创建成功后，返回最新的私有列表 (保持原有逻辑)
    await getPost(req, res, true);

  } catch (error) {
    console.error("Create Post Error:", error.message);
    res.status(500).send("Server Error");
  }
});

/**
 * @route   PUT /api/posts/:id
 * @desc    更新文章
 * @access  Private (Auth + CheckPrivate)
 */
router.put("/:id", async (req, res) => {
  let { name, info, author, content, code, code2, isPrivate, codeGroup, tags } = req.body;
  
  try {
    // 数据预处理
    if (tags && typeof tags === 'string') tags = tags.trim().split(" ");
    if (Array.isArray(code)) code = code.join('\n');
    if (Array.isArray(code2)) code2 = code2.join('\n');

    const updateFields = { name, info, author, content, code, code2, codeGroup, isPrivate, tags };
    
    // 执行更新
    const updatedPost = await Post.updateOne({ _id: req.params.id }, { $set: updateFields });
    
    // 🔥 审计日志
    logOperation({
      operatorId: req.user.id,
      action: "UPDATE_POST",
      target: updatedPost.name || req.params.id, // 防止 name 为空
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 更新完成后，返回最新的私有列表
    await getPost(req, res, true);

  } catch (error) {
    console.error("Update Post Error:", error.message);
    res.status(500).send("Server Error when updating post");
  }
});

/**
 * @route   DELETE /api/posts/:id
 * @desc    删除文章 (需要 SecretKey 校验私有文章)
 * @access  Private (Auth + CheckPrivate)
 */
router.delete("/:id", async (req, res) => {
  const { secretKey } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || "bananaboom-666";

  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // 私有文章删除时的双重保险
    const wasPrivate = post.isPrivate;
    if (wasPrivate) {
      if (secretKey !== ADMIN_SECRET) {
        return res.status(403).json({ message: "暗号错误！删除私有日志需要超级权限。" });
      }
    }

    await Post.findByIdAndDelete(req.params.id);

    // 🔥 审计日志
    logOperation({
      operatorId: req.user.id,
      action: "DELETE_POST",
      target: post.name,
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 删除后返回列表 (如果删的是私有，返回私有列表；否则返回公开列表)
    await getPost(req, res, wasPrivate);

  } catch (error) {
    console.error("Delete Post Error:", error);
    res.status(500).send("Server Error");
  }
});

// =================================================================
// 👍 点赞互动接口 (Interaction Routes)
// =================================================================

/**
 * @route   POST /api/posts/likes/:id/add
 * @desc    点赞 (+1)
 * @access  Public
 */
router.post("/likes/:id/add", async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $inc: { likes: 1 } });
    await getLikes(req, res);
  } catch (error) { 
    console.error("Add Like Error:", error); 
  }
});

/**
 * @route   POST /api/posts/likes/:id/remove
 * @desc    取消点赞 (-1)
 * @access  Public
 */
router.post("/likes/:id/remove", async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $inc: { likes: -1 } });
    await getLikes(req, res);
  } catch (error) { 
    console.error("Remove Like Error:", error); 
  }
});

module.exports = router;