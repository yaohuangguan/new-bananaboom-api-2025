const express = require("express");
const router = express.Router();
const Photo = require("../models/Photo");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

// 🔥 全局鉴权
router.use(auth, checkPrivate);

// 1. 【查阅】获取所有照片
// GET /api/photos
router.get("/", async (req, res) => {
  try {
    // 按时间倒序
    const photos = await Photo.find().sort({ createdDate: -1 });
    res.json(photos);
  } catch (error) {
    console.error("Fetch photos error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// 2. 【存储】新增一张照片 (支持自定义时间)
// POST /api/photos
router.post("/", async (req, res) => {
  const { url, name, createdDate } = req.body;

  if (!url) {
    return res.status(400).json({ message: "URL is required" });
  }

  try {
    const newPhoto = new Photo({
      url,
      name: name || "未命名",
      // 如果前端传了时间就用传的，没传就用当前时间
      createdDate: createdDate || new Date() 
    });

    await newPhoto.save();
    
    const allPhotos = await Photo.find().sort({ createdDate: -1 });
    res.json(allPhotos); 

  } catch (error) {
    console.error("Add photo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// 3. 【修改】修改照片信息 (URL、名字、时间)
// PUT /api/photos/:id
router.put("/:id", async (req, res) => {
  const { url, name, createdDate } = req.body;

  // 构建更新内容
  const updateFields = {};
  if (url) updateFields.url = url;
  if (name) updateFields.name = name;
  if (createdDate) updateFields.createdDate = createdDate; // 新增：支持改时间

  try {
    const updatedPhoto = await Photo.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    );

    if (!updatedPhoto) {
      return res.status(404).json({ message: "Photo not found" });
    }

    // 返回最新列表
    const allPhotos = await Photo.find().sort({ createdDate: -1 });
    res.json(allPhotos);

  } catch (error) {
    console.error("Update photo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// 4. 【删除】
// DELETE /api/photos/:id
router.delete("/:id", async (req, res) => {
  try {
    await Photo.findByIdAndDelete(req.params.id);
    
    const allPhotos = await Photo.find().sort({ createdDate: -1 });
    res.json(allPhotos);
  } catch (error) {
    console.error("Delete photo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;