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
const getPost = async (_req, res, isPrivate) => {
  try {
    const response = await Post.find({ isPrivate }).sort({
      createdDate: -1,
    });

    if (isPrivate) {
      if (Object.prototype.toString.call(response) === "[object Object]") {
        let array = [].concat(response);
        return res.json(array);
      }
      fs.writeFile("private_post.txt", response, (err) => {
        if (err) {
          console.log(err);
        }
        console.log("The file was saved! file name: private_post.txt");
      });
      return res.json(response);
    }

    return res.json(response);
  } catch (error) {
    console.error(err);
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
  const {
    name,
    info,
    author,
    content,
    code,
    code2,
    isPrivate,
    codeGroup,
  } = req.body;
  let { tags } = req.body;
  try {
    const createdDate = getCreateTime();

    if (tags) {
      tags = tags.trim().split(" ");
    }

    const newPost = new Post({
      name,
      info,
      author,
      createdDate,
      likes: 0,
      tags,
      content,
      code,
      code2,
      codeGroup,
      isPrivate,
    });

    await newPost.save();
    await getPost(req, res, true);
  } catch (error) {
    console.error(error.message);
    res.status(500).send("Server Error");
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
