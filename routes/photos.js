import { Router } from 'express';
const router = Router();
import Photo from '../models/Photo.js';

// ==========================================
// 1. 【查阅】获取所有照片
// ==========================================
// GET /api/photos
router.get('/', async (req, res) => {
  try {
    // 🔥 修改排序方式：改为按 'order' 字段从小到大排序 (升序)
    const photos = await Photo.find().sort({ order: 1 });
    res.json(photos);
  } catch (error) {
    console.error('Fetch photos error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ==========================================
// 2. 【存储】新增一张照片
// ==========================================
// POST /api/photos
router.post('/', async (req, res) => {
  const { url, name, createdDate } = req.body;

  if (!url) {
    return res.status(400).json({ message: 'URL is required' });
  }

  try {
    // 🔥 计算新的 order 值：找到当前最大的 order，然后 +1，保证新照片在最后面
    // 如果没有照片，就从 0 开始
    const lastPhoto = await Photo.findOne().sort({ order: -1 });
    const newOrder = lastPhoto && lastPhoto.order !== undefined ? lastPhoto.order + 1 : 0;

    const newPhoto = new Photo({
      url,
      name: name || '未命名',
      createdDate: createdDate || new Date(),
      order: newOrder // 设置计算好的 order
    });

    await newPhoto.save();

    // 返回最新的按 order 排序的列表
    const allPhotos = await Photo.find().sort({ order: 1 });
    res.json(allPhotos);
  } catch (error) {
    console.error('Add photo error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ==========================================
// 🔥🔥🔥 3. 【新增接口】批量重排序
// ==========================================
// PUT /api/photos/reorder
// Body: { newOrderIds: ["id_of_photo1", "id_of_photo2", ...] } (前端拖拽后的 ID 顺序列表)
router.put('/reorder', async (req, res) => {
  const { newOrderIds } = req.body;

  if (!newOrderIds || !Array.isArray(newOrderIds)) {
    return res.status(400).json({ message: '请提供新的 ID 排序列表数组' });
  }

  try {
    // 使用 MongoDB 的 bulkWrite 进行高效批量更新
    // 遍历前端传来的 ID 数组，数组的下标 (index) 就是它们新的 order 值
    const operations = newOrderIds.map((id, index) => {
      return {
        updateOne: {
          filter: { _id: id },
          update: { $set: { order: index } } // 将 order 设置为当前的索引值
        }
      };
    });

    if (operations.length > 0) {
      await Photo.bulkWrite(operations);
    }

    // 更新完成后，返回最新的排序列表
    const allPhotos = await Photo.find().sort({ order: 1 });
    res.json(allPhotos);
  } catch (error) {
    console.error('Reorder photos error:', error);
    res.status(500).json({ message: 'Server Error during reorder' });
  }
});

// ==========================================
// 4. 【修改】修改照片单个信息
// ==========================================
// PUT /api/photos/:id
router.put('/:id', async (req, res) => {
  const { url, name, createdDate } = req.body;

  const updateFields = {};
  if (url) updateFields.url = url;
  if (name) updateFields.name = name;
  if (createdDate) updateFields.createdDate = createdDate;

  try {
    const updatedPhoto = await Photo.findByIdAndUpdate(req.params.id, { $set: updateFields }, { new: true });

    if (!updatedPhoto) {
      return res.status(404).json({ message: 'Photo not found' });
    }

    // 返回最新排序列表
    const allPhotos = await Photo.find().sort({ order: 1 });
    res.json(allPhotos);
  } catch (error) {
    console.error('Update photo error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ==========================================
// 5. 【删除】
// ==========================================
// DELETE /api/photos/:id
router.delete('/:id', async (req, res) => {
  try {
    await Photo.findByIdAndDelete(req.params.id);

    // 返回最新排序列表
    const allPhotos = await Photo.find().sort({ order: 1 });
    res.json(allPhotos);
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

export default router;
