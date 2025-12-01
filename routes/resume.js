const express = require("express");

const router = express.Router();
const Resume = require("../models/Resume");


router.get("/", async (req, res) => {
  try {
    const response = await Resume.find();
    res.setHeader('Cache-Control','max-age=3600')

    res.json(response);
  } catch (error) {
    console.log(error);
  }
});
router.post("/", async (req, res) => {
  const { title, _title, info, _info, degree, url } = req.body;
  try {
    const response = new Resume({
      title,
      _title,
      info,
      _info,
      degree,
      url
    });
    const resume = await response.save();

    res.json(resume);
  } catch (error) {
    console.log(error);
  }
});

module.exports = router