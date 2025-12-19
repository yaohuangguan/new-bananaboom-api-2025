const express = require('express');
const router = express.Router();
const Fitness = require('../models/Fitness');
const User = require('../models/User'); 
const auth = require('../middleware/auth');

// ==========================================
// 1. 获取健身记录 (支持多人 & 筛选)
// ==========================================
// @route   GET api/fitness
// @desc    获取记录
router.get('/', auth, async (req, res) => {
  try {
    const { start, end, email } = req.query;
    
    let query = {};

    // 1. 如果传了 email，先查出 ID 再筛选
    if (email) {
        const targetUser = await User.findOne({ email: email });
        if (targetUser) {
            query.user = targetUser._id;
        } else {
            return res.json([]); 
        }
    } else {
        // 如果没传 email，默认查当前登录用户的所有记录 (或者你也可以不加这个限制，看需求)
        // query.user = req.user.id; 
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
      // 关联查出用户信息
      .populate('user', 'name displayName email avatar photoURL'); 

    res.json(records);
  } catch (err) {
    console.error("获取健身记录失败:", err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 2. 提交/更新记录 (🔥 核心修改：自动补全身高)
// ==========================================
// @route   POST api/fitness
// @desc    创建或更新记录
router.post('/', auth, async (req, res) => {
  try {
    const { 
      date, 
      targetUserEmail, 
      body, // 里面包含 weight, height(可选)
      workout, 
      diet, 
      status, 
      photos 
    } = req.body;

    if (!date) {
        return res.status(400).json({ msg: 'Date is required' });
    }

    // 1. 确定最终要操作的用户 (查 ID 和 查身高)
    let finalUserId = req.user.id; // 默认当前用户
    let userBaseHeight = null;     // 用于存从 User 表查到的身高

    // 逻辑：无论是否代打卡，都要查一下 User 表获取身高作为默认值
    if (targetUserEmail) {
        const targetUser = await User.findOne({ email: targetUserEmail });
        if (!targetUser) {
            return res.status(404).json({ msg: `找不到邮箱为 ${targetUserEmail} 的用户` });
        }
        finalUserId = targetUser._id;
        userBaseHeight = targetUser.height; // 获取目标用户的身高
    } else {
        // 如果是给自己打卡，也要查一下自己的身高
        const currentUser = await User.findById(req.user.id);
        if (currentUser) {
            userBaseHeight = currentUser.height;
        }
    }

    // 2. 处理日期
    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0];

    // 3. 构建 body 对象 (处理身高逻辑)
    // 如果前端传了 body.height 就用前端的，否则用 User 表里的 userBaseHeight
    const finalBody = body || {};
    if (!finalBody.height && userBaseHeight) {
        finalBody.height = userBaseHeight;
    }
    // 注意：这里不需要手动算 BMI，Fitness Model 的 pre('save') 会自动处理

    // 4. 构建更新字段
    const updateFields = {
      user: finalUserId, 
      date: dateObj,
      dateStr: dateStr,
      body: finalBody,     // 🔥 包含了 weight 和自动补全的 height
      workout: workout || {}, 
      diet: diet || {},
      status: status || {},   
      photos: photos || []
    };

    // 5. Upsert
    // 注意：findOneAndUpdate 默认不会触发 pre('save') 钩子，除非设置 { new: true } 并且在 mongoose 插件层处理，
    // 但通常建议如果需要计算字段，先 find 再 save，或者依赖前端算好。
    // 为了保险起见，Mongoose 的 pre('save') 只有在 .save() 时触发。
    // 如果用 findOneAndUpdate，我们需要手动 trigger 或者在 schema 使用 pre('findOneAndUpdate')。
    
    // 🔥 最佳实践修正：使用 findOne 然后 save，确保触发 BMI 计算逻辑
    let record = await Fitness.findOne({ user: finalUserId, dateStr: dateStr });

    if (record) {
        // 更新现有记录
        record.body = { ...record.body, ...finalBody }; // 合并数据
        if (workout) record.workout = workout;
        if (diet) record.diet = diet;
        if (status) record.status = status;
        if (photos) record.photos = photos;
    } else {
        // 创建新记录
        record = new Fitness(updateFields);
    }

    // 这一步会触发 FitnessSchema.pre('save')，自动计算 BMI
    await record.save();

    res.json(record);
  } catch (err) {
    console.error("保存健身记录失败:", err.message);
    res.status(500).send('Server Error');
  }
});

// ==========================================
// 3. 获取统计趋势 (增加 BMI 数据)
// ==========================================
router.get('/stats', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    
    let targetUserId = req.user.id; 

    if (req.query.email) {
        const user = await User.findOne({ email: req.query.email });
        if (user) {
            targetUserId = user._id;
        } else {
            return res.status(404).json({ msg: "User not found" });
        }
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = await Fitness.find({
      user: targetUserId,
      date: { $gte: startDate }
    })
    .sort({ date: 1 })
    // 🔥 查出 bmi
    .select('dateStr body.weight body.bmi workout.duration diet.water status.sleepHours');

    const chartData = {
      dates: stats.map(s => s.dateStr),
      weights: stats.map(s => s.body?.weight || null),
      // 🔥 新增 BMI 趋势
      bmis: stats.map(s => s.body?.bmi || null),
      durations: stats.map(s => s.workout?.duration || 0),
      water: stats.map(s => s.diet?.water || null),
      sleep: stats.map(s => s.status?.sleepHours || null)
    };

    res.json(chartData);

  } catch (err) {
    console.error("Stats Error:", err);
    res.status(500).send('Server Error');
  }
});

// DELETE 接口
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