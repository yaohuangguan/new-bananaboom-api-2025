const express = require('express');
const router = express.Router();
const Fitness = require('../models/Fitness');
const User = require('../models/User'); // 🔥 新增：必须引入 User 模型才能查邮箱
const auth = require('../middleware/auth');


// ==========================================
// 1. 获取健身记录 (支持多人)
// ==========================================
// @route   GET api/fitness
// @desc    获取记录
router.get('/', auth, async (req, res) => {
  try {
    const { start, end, email } = req.query; // 你也可以支持按 email 筛选查询
    
    let query = {};

    // 1. 如果传了 email，先查出 ID 再筛选
    if (email) {
        const targetUser = await User.findOne({ email: email });
        if (targetUser) {
            query.user = targetUser._id;
        } else {
            // 如果查不到这个人，直接返回空数组，或者报错，这里选择返回空以防崩溃
            return res.json([]); 
        }
    }

    // 2. 日期范围
    if (start && end) {
      query.date = { 
        $gte: new Date(start), 
        $lte: new Date(end) 
      };
    }

    const records = await Fitness.find(query)
      .sort({ date: -1 })
      // 关联查出用户信息，方便前端展示
      .populate('user', 'name displayName email avatar photoURL'); 

    res.json(records);
  } catch (err) {
    console.error("获取健身记录失败:", err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 提交/更新记录 (支持用 Email 帮他人打卡)
// ==========================================
// @route   POST api/fitness
// @desc    创建或更新记录 (支持 targetUserEmail)
// @access  Private
router.post('/', auth, async (req, res) => {
  try {
    const { 
      date, 
      targetUserEmail, // 🔥 核心修改：改用更好记的邮箱
      body, 
      workout, 
      diet, 
      status, 
      photos 
    } = req.body;

    if (!date) {
        return res.status(400).json({ msg: 'Date is required' });
    }

    // 1. 确定最终要操作的用户 ID
    let finalUserId = req.userId; // 默认为当前登录用户

    // 如果前端传了 email，说明是要帮别人(或自己)指定账号打卡
    if (targetUserEmail) {
        // 去 User 表查找这个邮箱对应的用户
        const targetUser = await User.findOne({ email: targetUserEmail });
        
        if (!targetUser) {
            return res.status(404).json({ msg: `找不到邮箱为 ${targetUserEmail} 的用户` });
        }
        
        finalUserId = targetUser._id; // 找到了，使用该用户的 ID
    }

    // 2. 处理日期
    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0];

    // 3. 构建更新字段
    const updateFields = {
      user: finalUserId, 
      date: dateObj,
      dateStr: dateStr,
      body: body || {},
      workout: workout || {}, 
      diet: diet || {},
      status: status || {},   
      photos: photos || []
    };

    // 4. Upsert
    const record = await Fitness.findOneAndUpdate(
      { user: finalUserId, dateStr: dateStr },
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
// GET /stats
// 获取统计趋势 (防曲线跳水版)
// ==========================================
router.get('/stats', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    
    // 1. 确定查询的目标用户
    let targetUserId = req.user.id; // 默认查自己 (假设 auth 中间件把 id 放在 req.user.id)
    
    // 如果是旧代码风格可能是 req.userId，请根据你的 auth 中间件实际情况调整
    // let targetUserId = req.userId; 

    // 如果前端传了 email 想看别人的趋势
    if (req.query.email) {
        const user = await User.findOne({ email: req.query.email });
        if (user) {
            targetUserId = user._id;
        } else {
            return res.status(404).json({ msg: "User not found" });
        }
    }

    // 2. 确定时间范围
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // 3. 数据库查询
    const stats = await Fitness.find({
      user: targetUserId,
      date: { $gte: startDate }
    })
    .sort({ date: 1 }) // 按日期升序
    .select('dateStr body.weight workout.duration diet.water status.sleepHours');

    // 4. 数据清洗与映射
    const chartData = {
      dates: stats.map(s => s.dateStr),
      
      // --- 核心身体指标 (使用 null 防止曲线掉底) ---
      weights: stats.map(s => s.body?.weight || null),
      
      // --- 运动时长 (使用 0 代表休息日) ---
      durations: stats.map(s => s.workout?.duration || 0),
      
      // --- 喝水 (使用 null 防止曲线掉底) ---
      // 这里的逻辑是：没记不代表没喝，用 0 会拉低平均值且导致图表难看
      water: stats.map(s => s.diet?.water || null),
      
      // --- 睡眠 (使用 null 防止曲线掉底) ---
      sleep: stats.map(s => s.status?.sleepHours || null)
    };

    res.json(chartData);

  } catch (err) {
    console.error("Stats Error:", err);
    res.status(500).send('Server Error');
  }
});

// DELETE 接口保持不变 (略)
router.delete('/:id', auth, async (req, res) => {
    try {
      const record = await Fitness.findById(req.params.id);
      if (!record) return res.status(404).json({ msg: 'Record not found' });
      await record.deleteOne();
      res.json({ msg: 'Record removed' });
    } catch (err) {
      res.status(500).send('Server Error');
    }
});

module.exports = router;