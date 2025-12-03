const express = require('express');
const router = express.Router();
const Fitness = require('../models/Fitness');
const auth = require('../middleware/auth');

// ==========================================
// 1. 获取日历数据 (按月/日期范围查询)
// ==========================================
// @route   GET api/fitness
// @desc    获取指定时间段的所有记录 (用于填充日历)
router.get('/', auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = { user: req.userId };

    if (start && end) {
      query.date = { $gte: new Date(start), $lte: new Date(end) };
    }

    // 按日期倒序，日历展示需要
    const records = await Fitness.find(query).sort({ date: -1 });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 提交/更新 每日记录 (Upsert)
// ==========================================
// @route   POST api/fitness
// @desc    创建或更新某天的健身数据
router.post('/', auth, async (req, res) => {
  try {
    // 前端传过来的数据结构建议和 Model 保持一致，或者在这里解构
    // 假设前端传的是: { date: "2025-12-03", body: {...}, workout: {...}, ... }
    const { 
      date, 
      body, 
      workout, 
      nutrition, 
      status, 
      photos 
    } = req.body;

    if (!date) return res.status(400).json({ msg: 'Date is required' });

    // 处理日期
    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0];

    // 构建更新对象
    const updateFields = {
      user: req.userId,
      date: dateObj,
      dateStr: dateStr,
      // 使用 $set 的对象展开语法，防止局部更新时覆盖掉整个子对象
      // 但为了简单，如果前端每次都是传完整的子对象，直接覆盖也没问题。
      // 这里假设前端表单是完整的。
      body: body || {},
      workout: workout || {},
      nutrition: nutrition || {},
      status: status || {},
      photos: photos || []
    };

    // 执行 Upsert
    const record = await Fitness.findOneAndUpdate(
      { user: req.userId, dateStr: dateStr },
      { $set: updateFields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(record);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 3. 获取统计趋势 (新增功能)
// ==========================================
// @route   GET api/fitness/stats
// @desc    获取最近30天/90天的体重和运动时长数据 (用于Echarts/Chart.js)
router.get('/stats', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30; // 默认查最近30天
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = await Fitness.find({
      user: req.userId,
      date: { $gte: startDate }
    })
    .sort({ date: 1 }) // 按时间正序，方便画图
    .select('dateStr body.weight workout.duration nutrition.totalCalories'); 
    // 只取画图需要的字段，减少流量

    // 数据清洗，返回给前端直接可用的数组
    const chartData = {
      dates: stats.map(s => s.dateStr),
      weights: stats.map(s => s.body?.weight || null),
      durations: stats.map(s => s.workout?.duration || 0),
      calories: stats.map(s => s.nutrition?.totalCalories || 0)
    };

    res.json(chartData);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 4. 删除记录
// ==========================================
router.delete('/:id', auth, async (req, res) => {
  try {
    const record = await Fitness.findOne({ _id: req.params.id, user: req.userId });
    if (!record) return res.status(404).json({ msg: 'Not found' });
    await record.deleteOne();
    res.json({ msg: 'Removed' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

module.exports = router;