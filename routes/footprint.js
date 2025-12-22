import { Router } from 'express';
const router = Router();
import Footprint from '../models/Footprint.js';
import logOperation from '../utils/audit.js'; // 引入日志

// ==========================================
// 1. 获取足迹列表 + 点亮统计
// ==========================================
router.get('/', async (req, res) => {
  try {
    const { status } = req.query; // 可选: ?status=planned 只看想去的地方

    const query = { user: req.user.id };
    if (status) query.status = status;

    // 按时间倒序排列
    const footprints = await Footprint.find(query).sort({ visitDate: -1 });

    // --- 🔥 核心统计逻辑：计算点亮了哪些区域 ---
    // 只有状态为 'visited' 才算点亮
    const visitedList = footprints.filter((fp) => fp.status === 'visited');

    // 使用 Set 去重，统计去过的 国家 和 省份
    const litCountries = [...new Set(visitedList.map((fp) => fp.location.country).filter(Boolean))];
    const litProvinces = [...new Set(visitedList.map((fp) => fp.location.province).filter(Boolean))];
    const litCities = [...new Set(visitedList.map((fp) => fp.location.city).filter(Boolean))];

    res.json({
      code: 200,
      stats: {
        totalCount: visitedList.length,
        countries: litCountries, // e.g. ["中国", "日本"]
        provinces: litProvinces, // e.g. ["四川省", "北京市"] -> 给 ECharts map series 用
        citiesCount: litCities.length
      },
      data: footprints // 原始列表数据 (用于地图打点 Marker)
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 新增足迹 (点亮一个新地点)
// ==========================================
router.post('/', async (req, res) => {
  try {
    const {
      location, // { name, coordinates: [lng, lat], province, city ... }
      content,
      images,
      companions,
      rating,
      mood,
      cost,
      visitDate,
      status,
      isHighlight
    } = req.body;

    // 简单校验
    if (!location || !location.coordinates || location.coordinates.length !== 2) {
      return res.status(400).json({ msg: '地理位置坐标必填' });
    }

    const newFootprint = new Footprint({
      user: req.user.id,
      location,
      content,
      images,
      companions,
      rating,
      mood,
      cost,
      visitDate: visitDate || new Date(),
      status: status || 'visited',
      isHighlight: isHighlight || false
    });

    await newFootprint.save();

    // 记录操作日志
    logOperation({
      operatorId: req.user.id,
      action: 'ADD_FOOTPRINT',
      target: location.name, // 记录地名
      details: {
        province: location.province,
        status: newFootprint.status
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json(newFootprint);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 3. 获取单个足迹详情
// ==========================================
router.get('/:id', async (req, res) => {
  try {
    const footprint = await Footprint.findById(req.params.id);
    if (!footprint) return res.status(404).json({ msg: 'Not Found' });
    res.json(footprint);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 4. 修改足迹 (补充照片、修改心情)
// ==========================================
router.put('/:id', async (req, res) => {
  try {
    const { location, content, images, companions, rating, mood, cost, visitDate, status, isHighlight } = req.body;

    // 构建更新对象
    const updateFields = {};
    if (location) updateFields.location = location;
    if (content !== undefined) updateFields.content = content;
    if (images) updateFields.images = images;
    if (companions) updateFields.companions = companions;
    if (rating) updateFields.rating = rating;
    if (mood) updateFields.mood = mood;
    if (cost) updateFields.cost = cost;
    if (visitDate) updateFields.visitDate = visitDate;
    if (status) updateFields.status = status;
    if (isHighlight !== undefined) updateFields.isHighlight = isHighlight;

    const updatedFootprint = await Footprint.findByIdAndUpdate(req.params.id, { $set: updateFields }, { new: true });

    // 日志
    logOperation({
      operatorId: req.user.id,
      action: 'UPDATE_FOOTPRINT',
      target: updatedFootprint.location.name,
      details: { id: req.params.id, updatedFields: Object.keys(updateFields) },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json(updatedFootprint);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 5. 删除足迹
// ==========================================
router.delete('/:id', async (req, res) => {
  try {
    const footprint = await Footprint.findById(req.params.id);
    if (!footprint) return res.status(404).json({ msg: 'Not Found' });

    await footprint.deleteOne();

    logOperation({
      operatorId: req.user.id,
      action: 'DELETE_FOOTPRINT',
      target: footprint.location.name,
      details: { id: req.params.id },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    res.json({ msg: 'Deleted successfully' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

export default router;
