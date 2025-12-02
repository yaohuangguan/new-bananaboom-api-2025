const express = require("express");
const router = express.Router();
const Photo = require("../models/Photo");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

// 🔥 全局鉴权：只有登录且是 VIP (checkPrivate) 才能操作照片墙
router.use(auth, checkPrivate);

// 1. 【查阅】获取所有照片
// GET /api/photos
router.get("/", async (req, res) => {
  try {
    // 按创建时间倒序排列（最新的在前）
    const photos = await Photo.find().sort({ createdDate: -1 });
    res.json(photos);
  } catch (error) {
    console.error("Fetch photos error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// 2. 【存储】新增一张照片
// POST /api/photos
router.post("/", async (req, res) => {
  const { url, name } = req.body;

  if (!url) {
    return res.status(400).json({ message: "URL is required" });
  }

  try {
    const newPhoto = new Photo({
      url,
      name: name || "未命名", // 如果没传名字，给个默认值
      createdDate: new Date()
    });

    await newPhoto.save();
    
    // 返回最新的完整列表，方便前端直接更新视图
    // (也可以只返回 savedPhoto，看你前端怎么写，返回列表通常更省事)
    const allPhotos = await Photo.find().sort({ createdDate: -1 });
    res.json(allPhotos); 

  } catch (error) {
    console.error("Add photo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// 3. 【替换】修改某张照片的 URL 或 名字
// PUT /api/photos/:id
router.put("/:id", async (req, res) => {
  const { url, name } = req.body;

  // 构建更新内容
  const updateFields = {};
  if (url) updateFields.url = url;   // 如果传了新URL，就替换
  if (name) updateFields.name = name; // 如果传了新名字，就改名

  try {
    const updatedPhoto = await Photo.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true } // 返回修改后的文档，而不是修改前的
    );

    if (!updatedPhoto) {
      return res.status(404).json({ message: "Photo not found" });
    }

    // 同样，返回最新的完整列表，方便前端刷新
    const allPhotos = await Photo.find().sort({ createdDate: -1 });
    res.json(allPhotos);

  } catch (error) {
    console.error("Update photo error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// 4. 【删除】(可选)
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