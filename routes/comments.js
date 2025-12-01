const express = require("express");
const router = express.Router();
const Comment = require("../models/Comment");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const getCreateTime = require("../utils")

const getNewComments = async (req, res) => {
  try {
    const response = await Comment.find({ _postid: req.params.id });
    res.json(response);
  } catch (error) {
    res.status(404).json({ message: "Not found the comments" });
  }
};
const getNewReply = async (req, res) => {
  try {
    const response = await Comment.find(
      { id: req.params.id },
      {
        reply: 1,
      }
    );
    res.json(response);
  } catch (error) {
    res.status(400).json(error);
  }
};
router.get("/:id", async (req, res) => await getNewComments(req, res));
router.post("/:id", auth, async (req, res) => {
  const { user, comment, photoURL } = req.body;
  const { user_id } = req.query;
  if (!user)
    return res.status(400).json({ message: "please login to post comments" });
  if (!comment || comment == "")
    return res.status(400).json({ message: "Please say something" });

  const date = getCreateTime();
  const id = new mongoose.Types.ObjectId();
  try {
    const response = new Comment({
      user,
      id,
      date,
      comment,
      photoURL,
      _postid: req.params.id,
      _userid: user_id,
    });
    await response.save();
    await getNewComments(req, res);
  } catch (error) {
    res.status(400).json({ message: "Error when creating comments" });
  }
});
router.get("/reply/:id", async (req, res) => await getNewReply(req, res));
router.post("/reply/:id", auth, async (req, res) => {
  const { user, reply, photoURL, targetUser } = req.body;

  if (!reply || reply == "")
    return res.status(400).json({ message: "Please say something" });

  const date = getCreateTime();
  const id = new mongoose.Types.ObjectId();
  try {
    await Comment.updateOne(
      { id: req.params.id },
      {
        $push: {
          reply: {
            user,
            photoURL,
            content: reply,
            targetUser,
            date,
            id,
          },
        },
      }
    );
    await getNewReply(req, res);
  } catch (error) {
    res.status(400).json(error);
  }
});

module.exports = router;
