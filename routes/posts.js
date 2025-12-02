const express = require("express");
const getCreateTime = require("../utils");

const router = express.Router();
const logOperation = require("../utils/audit"); // 引入工具
const Post = require("../models/Post");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

const getLikes = async (req, res) => {
  try {
    const like = await Post.findOne({ _id: req.params.id }, { likes: 1 });
    res.json(like);
  } catch (error) {
    console.log(error);
  }
};

// 修改后的 getPost 函数
const getPost = async (req, res, isPrivate) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = { isPrivate };

    if (req.query.q) {
      const keyword = req.query.q;
      query.$or = [
        { name: { $regex: keyword, $options: 'i' } },
        { content: { $regex: keyword, $options: 'i' } }
      ];
    }

    if (req.query.tag) {
      query.tags = req.query.tag;
    }

    const [posts, total] = await Promise.all([
      Post.find(query)
        .sort({ createdDate: -1 })
        .skip(skip)
        .limit(limit)
        // 🔥🔥🔥 关键修改：返回所有字段，但排除 password
        .populate("user", "-password"), 
      
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

// 获取单篇文章详情
router.get("/:id", async (req, res) => {
  try {
    const response = await Post.find({ _id: req.params.id })
      // 🔥🔥🔥 关键修改：这里也要排除 password
      .populate("user", "-password");
      
    res.setHeader("Cache-Control", "max-age=3600");
    res.json(response);
  } catch (error) {
    res.status(404).json({ message: "Not found the posts" });
  }
});

router.get("/private/posts", auth, checkPrivate, async (req, res) => await getPost(req, res, true));

router.post("/", auth, async (req, res) => {
  let { name, info, author, content, code, code2, isPrivate, codeGroup, tags } = req.body;
  try {
    const createdDate = getCreateTime();
    if (tags && typeof tags === 'string') tags = tags.trim().split(" ");
    if (Array.isArray(code)) code = code.join('\n'); 
    if (Array.isArray(code2)) code2 = code2.join('\n');

    const newPost = new Post({
      name, info, author, createdDate, likes: 0, tags, content, code, code2, codeGroup, isPrivate,
      user: req.user.id
    });
    // 🔥🔥🔥 埋点记录日志 🔥🔥🔥
    logOperation({
      operatorId: req.user.id,
      action: "CREATE_POST",
      target: newPost.name,
      ip: req.ip,
      io: req.app.get('socketio') // 传入 socket 实例用于实时推送
  });

    await newPost.save();
    await getPost(req, res, true);
  } catch (error) {
    console.error(error.message);
    res.status(500).send("Server Error");
  }
});

router.put("/:id", auth, async (req, res) => {
  let { name, info, author, content, code, code2, isPrivate, codeGroup, tags } = req.body;
  try {
    if (tags && typeof tags === 'string') tags = tags.trim().split(" ");
    if (Array.isArray(code)) code = code.join('\n');
    if (Array.isArray(code2)) code2 = code2.join('\n');

    const updateFields = { name, info, author, content, code, code2, codeGroup, isPrivate, tags };
    const updatedPost = await Post.updateOne({ _id: req.params.id }, { $set: updateFields });
    // 🔥🔥🔥 埋点记录日志 🔥🔥🔥
    logOperation({
      operatorId: req.user.id,
      action: "UPDATE_POST",
      target: updatedPost.name,
      ip: req.ip,
      io: req.app.get('socketio') // 传入 socket 实例用于实时推送
  });
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
  } catch (error) { console.log(error); }
});
router.post("/likes/:id/remove", async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $inc: { likes: -1 } });
    await getLikes(req, res);
  } catch (error) { console.log(error); }
});

router.delete("/:id", auth, checkPrivate, async (req, res) => {
  const { secretKey } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || "bananaboom-666";
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const wasPrivate = post.isPrivate;
    if (wasPrivate) {
      if (secretKey !== ADMIN_SECRET) return res.status(403).json({ message: "暗号错误！删除私有日志需要超级权限。" });
    } 
    await Post.findByIdAndDelete(req.params.id);
    await getPost(req, res, wasPrivate);
  } catch (error) {
    console.error("Delete post error:", error);
    res.status(500).send("Server Error");
  }
});

module.exports = router;