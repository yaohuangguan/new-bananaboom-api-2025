const express = require("express");
const getCreateTime = require("../utils");

const router = express.Router();
const fs = require("fs");
const Post = require("../models/Post");
const auth = require("../middleware/auth");
const getLikes = async (req, res) => {
  try {
    const like = await Post.findOne({ _id: req.params.id }, { likes: 1 });
    console.log(req.params.id);

    res.json(like);
  } catch (error) {
    console.log(error);
  }
};
// 修改后的 getPost 函数，支持分页
const getPost = async (req, res, isPrivate) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // --- 🔥 新增：构建动态查询条件 ---
    const query = { isPrivate };

    // 1. 搜索功能 (Search)
    // 如果 URL 里有 ?q=keyword
    if (req.query.q) {
      const keyword = req.query.q;
      // 在标题(name) 或 内容(content) 中模糊搜索，'i' 表示忽略大小写
      query.$or = [
        { name: { $regex: keyword, $options: 'i' } },
        { content: { $regex: keyword, $options: 'i' } }
      ];
    }

    // 2. 标签筛选 (Filter by Tag)
    // 如果 URL 里有 ?tag=React
    if (req.query.tag) {
      // 假设你的 tags 字段是数组，MongoDB 会自动匹配数组中是否包含该值
      query.tags = req.query.tag;
    }
    // --------------------------------

    // 下面的逻辑不用变，直接把 query 传进去
    const [posts, total] = await Promise.all([
      Post.find(query)
        .sort({ createdDate: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(query)
    ]);

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
    console.error(error);
    res.status(500).send("Server Error when getting the post");
  }
};

router.get("/", async (req, res) => await getPost(req, res, false));
router.get("/:id", async (req, res) => {
  try {
    const response = await Post.find({ _id: req.params.id });
    res.setHeader("Cache-Control", "max-age=3600");
    res.json(response);
  } catch (error) {
    res.status(404).json({ message: "Not found the posts" });
  }
});
router.get(
  "/private/posts",
  auth,
  async (req, res) => await getPost(req, res, true)
);
router.post("/", auth, async (req, res) => {
 // 1. 改用 let 解构，允许我们在下面修改 code 的值
 let {
  name,
  info,
  author,
  content,
  code,
  code2,
  isPrivate,
  codeGroup,
  tags // 注意：有些旧代码这里是分开解构的，这里统一处理比较好
} = req.body;

try {
  const createdDate = getCreateTime();

  // 2. 处理标签 (Tags)
  if (tags && typeof tags === 'string') {
    tags = tags.trim().split(" ");
  }

  // 🔥🔥🔥 3. 新增：兼容处理 code 字段 (防止空数组报错) 🔥🔥🔥
  if (Array.isArray(code)) {
    // 如果是数组，转成字符串（或者直接设为 ""）
    code = code.join('\n'); 
  }
  if (Array.isArray(code2)) {
    code2 = code2.join('\n');
  }

  // 4. 创建新文章对象
  const newPost = new Post({
    name,
    info,
    author,
    createdDate,
    likes: 0,
    tags,
    content,
    code,      // 此时它是安全的字符串
    code2,     // 此时它是安全的字符串
    codeGroup,
    isPrivate,
  });

  await newPost.save();
  
  // 5. 返回最新的文章列表
  await getPost(req, res, true);
  } catch (error) {
    console.error(error.message);
    res.status(500).send("Server Error");
  }
});

// --- 新增的 Update 接口 ---
router.put("/:id", auth, async (req, res) => {
 // 1. 先把 code 单独解构出来，注意这里用 let
 let {
  name,
  info,
  author,
  content,
  code,  // <--- 这里
  code2,
  isPrivate,
  codeGroup,
  tags
} = req.body;

try {
  // ... 原有的 tags 处理逻辑 ...
  if (tags && typeof tags === 'string') {
    tags = tags.trim().split(" ");
  }

  // 🔥🔥🔥 新增：兼容处理 code 字段 🔥🔥🔥
  // 如果前端传过来的是数组（比如 []），我们把它转成空字符串或者用换行符连接
  if (Array.isArray(code)) {
      code = code.join('\n'); // 或者直接 code = ""; 看你需求
  }
  // 同理，防止 code2 也出问题
  if (Array.isArray(code2)) {
      code2 = code2.join('\n');
  }

  const updateFields = {
    name,
    info,
    author,
    content,
    code, // 现在它是安全的字符串了
    code2,
    codeGroup,
    isPrivate,
    tags 
  };

    await Post.updateOne(
      { _id: req.params.id }, 
      { $set: updateFields }
    );

    await getPost(req, res, true);
  } catch (error) {
    console.error(error.message);
    res.status(500).send("Server Error when updating post");
  }
});

router.get("/likes/:id", async (req, res) => await getLikes(req, res));
router.post("/likes/:id/add", async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $inc: { likes: 1 } });
    await getLikes(req, res);
  } catch (error) {
    console.log(error);
  }
});
router.post("/likes/:id/remove", async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $inc: { likes: -1 } });
    await getLikes(req, res);
  } catch (error) {
    console.log(error);
  }
});
router.delete("/:id", async (req, res) => {
  try {
    await Post.deleteOne({ _id: req.params.id });
    await getPost(req,res,true)
  } catch (error) {
    console.log(error);
  }
});
module.exports = router;
