const express = require('express');
const router = express.Router();
const Fitness = require('../models/Fitness');
const auth = require('../middleware/auth');

// ==========================================
// 1. 获取日历数据 (按月/日期范围查询)
// ==========================================
// @route   GET api/fitness
// @desc    获取指定时间段的所有记录 (用于前端日历展示 ✅ 🏋️)
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = { user: req.userId };

    // 如果传了日期范围 (例如: ?start=2025-12-01&end=2025-12-31)
    if (start && end) {
      query.date = { 
        $gte: new Date(start), 
        $lte: new Date(end) 
      };
    }

    // 按日期倒序返回，日历组件通常需要把这个转成 Map
    const records = await Fitness.find(query).sort({ date: -1 });
    res.json(records);
  } catch (err) {
    console.error("获取健身记录失败:", err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 提交/更新 每日记录 (Upsert)
// ==========================================
// @route   POST api/fitness
// @desc    打卡或更新某天的记录 (自动判断新增还是修改)
// @access  Private
router.post('/', auth, async (req, res) => {
  try {
    // 解构前端传来的简化版数据
    const { 
      date, 
      body,     // { weight: 70 }
      workout,  // { isDone: true, duration: 60, types: ["跑步"], note: "..." }
      diet,     // { content: "早饭面包...", water: 4 }
      status,   // { mood: "happy", sleepHours: 8 }
      photos    // ["url1", "url2"]
    } = req.body;

    if (!date) return res.status(400).json({ msg: 'Date is required' });

    // 统一格式化日期
    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD

    // 构建更新字段 (与新的简化 Schema 保持一致)
    const updateFields = {
      user: req.userId,
      date: dateObj,
      dateStr: dateStr,
      
      // 使用 || {} 防止前端没传某一项导致报错，
      // 注意：这里是直接覆盖子对象。如果前端只传了 weight 没传 chest，
      // 因为 schema 里已经没有 chest 了，所以直接覆盖没问题。
      body: body || {},       
      workout: workout || {}, 
      diet: diet || {},       // 注意这里是 diet，不是 nutrition
      status: status || {},   
      photos: photos || []
    };

    // 🔥 核心逻辑：Upsert (有则改，无则加)
    const record = await Fitness.findOneAndUpdate(
      { user: req.userId, dateStr: dateStr },
      { $set: updateFields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(record);
  } catch (err) {
    console.error("保存健身记录失败:", err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 3. 获取简易趋势 (Chart Data)
// ==========================================
// @route   GET api/fitness/stats
// @desc    获取最近30天的体重和运动时长趋势
// @access  Private
router.get('/stats', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30; // 默认查最近30天
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = await Fitness.find({
      user: req.userId,
      date: { $gte: startDate }
    })
    .sort({ date: 1 }) // 按时间正序
    .select('dateStr body.weight workout.duration'); // 只取画图需要的字段

    // 格式化给前端图表库 (Echarts / Chart.js) 直接使用
    const chartData = {
      dates: stats.map(s => s.dateStr),
      weights: stats.map(s => s.body?.weight || null), // 处理空值
      durations: stats.map(s => s.workout?.duration || 0)
    };

    res.json(chartData);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 4. 删除某天的记录
// ==========================================
// @route   DELETE api/fitness/:id
// @access  Private
router.delete('/:id', auth, async (req, res) => {
  try {
    const record = await Fitness.findOne({ _id: req.params.id, user: req.userId });
    if (!record) return res.status(404).json({ msg: 'Record not found' });
    
    await record.deleteOne();
    res.json({ msg: 'Record removed' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

module.exports = router;