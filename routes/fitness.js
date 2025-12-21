const express = require('express');
const router = express.Router();
const Fitness = require('../models/Fitness');
const User = require('../models/User'); 
const auth = require('../middleware/auth');
// 🔥 1. 引入权限控制模块
const checkPermission = require('../middleware/checkPermission');
const K = require('../config/permissionKeys');
const permissionService = require('../services/permissionService'); // ✅ 引入服务

// =================================================================
// 1. 获取健身记录 (支持多人 & 筛选) - 智能权限控制
// =================================================================
// @route   GET api/fitness
// @desc    获取记录
// 门槛：拥有 FITNESS_USE (Admin, User, Super Admin 都有)
router.get('/', auth, checkPermission(K.FITNESS_USE), async (req, res) => {
  try {
    const { start, end, email } = req.query;
    const currentUser = req.user;
    
   // ============================================================
    // 🔥 2. 权限计算 (使用 Service 封装方法)
    // ============================================================
    // 这里不再读取静态文件，而是从 Service 计算最终权限集合
    const allPerms = permissionService.getUserMergedPermissions(currentUser);

    // 是否有“上帝视角” (Super Admin 或 拥有 FITNESS_READ_ALL 特权)
    const canReadAll = allPerms.includes('*') || allPerms.includes(K.FITNESS_READ_ALL);

    // --- 2. 构建查询条件 ---
    let query = {};

    // 👉 情况 A: 前端指定查某人
    if (email) {
      // 鉴权：查别人必须有上帝视角
      if (email !== currentUser.email && !canReadAll) {
        return res.status(403).json({ msg: "权限不足：你无权查看他人记录" });
      }

      const targetUser = await User.findOne({ email: email });
      if (!targetUser) return res.json([]); // 查无此人
      
      query.user = targetUser._id;
    } 
    // 👉 情况 B: 默认行为
    else {
      if (!canReadAll) {
        // 普通人强制看自己
        query.user = currentUser.id;
      }
      // 上帝视角且没传 email -> query.user = undefined (查所有人)
    }

    // --- 3. 日期筛选 (修复结束时间包含当天的问题) ---
    if (start && end) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      // 🔥 核心修正：确保 endDate 包含当天的 23:59:59
      endDate.setHours(23, 59, 59, 999); 

      query.date = { 
        $gte: startDate, 
        $lte: endDate 
      };
    }

    // --- 4. 构建 Query 链 ---
    let dbQuery = Fitness.find(query)
      .sort({ date: -1 })
      .populate('user', 'name displayName email avatar photoURL role');

    // 🔥 智能 Limit：
    // 只有在“管理员看全员大盘”时限制 100 条，防止数据爆炸。
    // 如果管理员是指定看某个人(query.user有值)，或者普通人看自己，则不限制，展示所有历史。
    if (canReadAll && !query.user) {
        dbQuery = dbQuery.limit(100);
    }

    const records = await dbQuery;

    res.json(records);

  } catch (err) {
    console.error("Get Fitness Error:", err);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 2. 提交/更新记录 (自动补全身高 + 帮人打卡权限)
// =================================================================
// @route   POST api/fitness
// @desc    创建或更新记录
router.post('/', auth, checkPermission(K.FITNESS_USE), async (req, res) => {
  try {
    const { 
      date, 
      targetUserEmail, 
      body, 
      workout, 
      diet, 
      status, 
      photos 
    } = req.body;

    if (!date) {
        return res.status(400).json({ msg: 'Date is required' });
    }

    // --- 🛡️ 权限与用户定位逻辑 ---
    let finalUserId = req.user.id; // 默认：自己
    let userBaseHeight = null;     // 默认：从自己身上查身高

    // 如果指定了 targetUserEmail (想帮别人打卡)
    if (targetUserEmail) {
        // 1. 安全检查：如果目标不是自己，必须是 Super Admin
        // (注：这里使用邮箱比对，更直观)
        const isSelf = (targetUserEmail === req.user.email);
        const isSuperAdmin = (req.user.role === 'super_admin');

        if (!isSelf && !isSuperAdmin) {
            return res.status(403).json({ msg: "权限不足：只有超级管理员能帮他人打卡" });
        }

        // 2. 查找目标用户
        const targetUser = await User.findOne({ email: targetUserEmail });
        if (!targetUser) {
            return res.status(404).json({ msg: `找不到邮箱为 ${targetUserEmail} 的用户` });
        }
        
        // 3. 锁定目标
        finalUserId = targetUser._id;
        userBaseHeight = targetUser.height; 
    } else {
        // 给自己打卡，查自己的身高
        const currentUser = await User.findById(req.user.id);
        if (currentUser) {
            userBaseHeight = currentUser.height;
        }
    }

    // --- 📅 日期处理 ---
    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0];

    // --- 📏 智能补全 Body ---
    const finalBody = body || {};
    // 逻辑保留：如果前端没传 height，但 User 表里有，就补全
    if (!finalBody.height && userBaseHeight) {
        finalBody.height = userBaseHeight;
    }

    // --- 💾 数据库操作 (保留 Find -> Save 模式以触发 Hook) ---
    // 先尝试查找当天记录
    let record = await Fitness.findOne({ user: finalUserId, dateStr: dateStr });

    if (record) {
        // 更新模式: 合并数据
        record.body = { ...record.body, ...finalBody }; 
        if (workout) record.workout = workout;
        if (diet) record.diet = diet;
        if (status) record.status = status;
        if (photos) record.photos = photos;
    } else {
        // 创建模式
        record = new Fitness({
            user: finalUserId,
            date: dateObj,
            dateStr: dateStr,
            body: finalBody,
            workout: workout || {},
            diet: diet || {},
            status: status || {},
            photos: photos || []
        });
    }

    // 🔥 触发 pre('save') 计算 BMI
    await record.save();

    // 为了前端显示方便，populate 一下用户信息
    await record.populate('user', 'displayName photoURL'); // 可选

    res.json(record);
  } catch (err) {
    console.error("保存健身记录失败:", err.message);
    res.status(500).send('Server Error');
  }
});

// =================================================================
// 3. 获取统计趋势 (权限控制版)
// =================================================================
router.get('/stats', auth, checkPermission(K.FITNESS_USE), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const currentUser = req.user;
    let targetUserId = currentUser.id; 

    // ============================================================
    // 🔥 1. 权限计算 (改为动态获取)
    // ============================================================
    // 获取当前用户的所有权限 (角色权限 + 个人特权)
    const allPerms = permissionService.getUserMergedPermissions(currentUser);

    // 判断是否有查看所有人数据的权限
    const canReadAll = allPerms.includes('*') || allPerms.includes(K.FITNESS_READ_ALL);

    // ============================================================
    // 🔥 2. 目标用户判定
    // ============================================================
    if (req.query.email) {
        // 如果查询的邮箱不是自己
        if (req.query.email !== currentUser.email) {
            
            // 鉴权：如果没有上帝视角，直接拒绝
            if (!canReadAll) {
                return res.status(403).json({ msg: "权限不足：你无权查看他人的统计数据" });
            }

            // 查找目标用户 ID
            const user = await User.findOne({ email: req.query.email });
            if (user) {
                targetUserId = user._id;
            } else {
                return res.status(404).json({ msg: "User not found" });
            }
        } 
        // else: 如果 email 是自己，targetUserId 默认就是自己，不用动
    }

    // ============================================================
    // 3. 执行查询与数据处理 (保持原有逻辑)
    // ============================================================
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = await Fitness.find({
      user: targetUserId,
      date: { $gte: startDate }
    })
    .sort({ date: 1 })
    .select('dateStr body.weight body.bmi workout.duration diet.water status.sleepHours');

    const chartData = {
      dates: stats.map(s => s.dateStr),
      weights: stats.map(s => s.body?.weight || null),
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

// =================================================================
// 4. 删除接口 (权限控制版)
// =================================================================
router.delete('/:id', auth, checkPermission(K.FITNESS_USE), async (req, res) => {
    try {
      const record = await Fitness.findById(req.params.id);
      if (!record) return res.status(404).json({ msg: 'Record not found' });
      
      // --- 🛡️ 鉴权：是自己的记录？ OR 是超级管理员？ ---
      const isOwner = record.user.toString() === req.user.id;
      const isSuperAdmin = req.user.role === 'super_admin';

      if (!isOwner && !isSuperAdmin) {
        return res.status(403).json({ msg: "你无权删除他人的记录" });
      }

      await record.deleteOne();
      res.json({ msg: 'Record removed' });
    } catch (err) {
      res.status(500).send('Server Error');
    }
});

module.exports = router;