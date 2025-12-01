const express = require("express");
const router = express.Router();
const Homepage = require("../models/Homepage");
const Project = require("../models/Project");
const Log = require("../models/Log");
const getLikes = async (req, res) => {
  try {
    const response = await Homepage.find({}, { likes: 1 });
    res.status(200).json(response);
  } catch (error) {
    res.status(404).json({ message: error });
  }
};
router.get("/", async (req, res) => {
  try {
    const response = await Homepage.find();
    res.status(200).json(response);
  } catch (error) {
    res.status(404).json({ message: error });
  }
});
router.get("/likes", async (req, res) => {
  getLikes(req, res);
});
router.post("/likes/:id/add", async (req, res) => {
  try {
    await Homepage.updateOne(
      { _id: req.params.id },
      {
        $inc: {
          likes: 1
        }
      }
    );
    getLikes(req, res);
  } catch (error) {
    res.status(404).json({ message: error });
  }
});
router.post("/likes/:id/remove", async (req, res) => {
  try {
    await Homepage.updateOne(
      { _id: req.params.id },
      { $inc: { likes: -1 } }
    );
    getLikes(req, res);
  } catch (error) {
    res.status(404).json({ message: error });
  }
});

router.get("/projects", async (_req, res) => {
  try {
    const response = await Project.find();
    res.setHeader("Cache-Control", "max-age=360000");

    res.status(200).json(response);
  } catch (error) {
    res.status(404).json({ message: error });
  }
});
router.get("/logs", async (_req, res) => {
  try {
    const response = await Log.find().sort({ version: 1 });
    res.setHeader("Cache-Control", "max-age=360000");

    res.status(200).json(response);
  } catch (error) {
    res.status(404).json({ message: error });
  }
});
module.exports = router;
