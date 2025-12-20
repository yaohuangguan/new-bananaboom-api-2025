const router = require("express").Router();
const Period = require("../models/Period");
const User = require("../models/User"); // 引入 User 以便做更复杂的家庭查询(可选)
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate"); 
const logOperation = require("../utils/audit");
const dayjs = require("dayjs");

// --- 核心算法 (保持不变) ---
const calculateCycleDetails = (records) => {
  let avgCycle = 28;
  let avgDuration = 5;

  if (records && records.length >= 2) {
    const recent = records.slice(0, 6);
    const validCycles = recent.filter(r => r.cycleLength > 20 && r.cycleLength < 45);
    if (validCycles.length > 0) {
      const totalDays = validCycles.reduce((sum, r) => sum + r.cycleLength, 0);
      avgCycle = Math.round(totalDays / validCycles.length);
    }
    const validDurations = recent.filter(r => r.duration > 2 && r.duration < 10);
    if (validDurations.length > 0) {
      const totalDur = validDurations.reduce((sum, r) => sum + r.duration, 0);
      avgDuration = Math.round(totalDur / validDurations.length);
    }
  }

  const lastRecord = records[0];
  const lastStart = lastRecord ? dayjs(lastRecord.startDate) : dayjs();

  // 预测节点
  const nextPeriodDate = lastStart.add(avgCycle, 'day');
  const ovulationDate = nextPeriodDate.subtract(14, 'day');
  const fertileStart = ovulationDate.subtract(5, 'day');
  const fertileEnd = ovulationDate.add(4, 'day');

  return {
    avgCycle,
    avgDuration,
    lastStart: lastStart.toDate(),
    prediction: {
      nextPeriodStart: nextPeriodDate.toDate(),
      ovulationDate: ovulationDate.toDate(),
      fertileWindow: {
        start: fertileStart.toDate(),
        end: fertileEnd.toDate()
      },
      desc: `预计 ${nextPeriodDate.format('MM-DD')} 来姨妈，${fertileStart.format('MM-DD')} 到 ${fertileEnd.format('MM-DD')} 是排卵期。`
    }
  };
};

/**
 * GET /api/period
 * 获取记录 (权限控制：普通用户看自己，管理员看所有)
 */
router.get("/", auth, checkPrivate, async (req, res) => {
  try {
    let query = {};

    // 🔥 权限控制核心逻辑
    if (req.user.role === 'super_admin') {
      // 👑 管理员(你): 可以看到所有人的记录 (主要是你老婆的)
      // 如果需要过滤只看家庭组，可以先查 User 表拿到 ID 列表，这里暂时全量查
      query = {}; 
    } else {
      // 👩 普通用户(老婆): 只能看到属于自己的记录
      query = { user: req.user.id };
    }

    const records = await Period.find(query)
      .sort({ startDate: -1 })
      .limit(24)
      .populate('user', 'displayName photoURL email'); // 关联用户信息，方便前端展示是谁的

    // 计算周期详情 (注意：如果是管理员看多人数据，这个算法是基于“混合数据”算的，或者前端应该选人查看)
    // 简单起见，这里直接返回 records，由前端决定怎么展示统计
    const cycleData = calculateCycleDetails(records);

    res.json({
      records,
      ...cycleData
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * POST /api/period
 * 新增记录 (强制绑定到当前登录用户)
 */
router.post("/", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note } = req.body;

  try {
    // 1. 找上一条记录 (🔥 只找自己的上一条，计算周期才准确)
    const lastRecord = await Period.findOne({ user: req.user.id }).sort({ startDate: -1 });
    
    let cycleLength = 0;
    if (lastRecord) {
      cycleLength = dayjs(startDate).diff(dayjs(lastRecord.startDate), 'day');
    }

    let duration = 5; 
    if (endDate) {
      duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    const newPeriod = new Period({
      user: req.user.id, // 🔥 核心：数据所有权归当前用户
      operator: req.user.id, // 操作者也是当前用户
      startDate,
      endDate,
      duration,
      cycleLength,
      symptoms,
      flow,
      note
    });

    await newPeriod.save();

    // 日志
    logOperation({
      operatorId: req.user.id,
      action: "ADD_PERIOD",
      target: "PeriodTracker",
      details: { date: startDate, cycleLength },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新数据 (只返回自己的，避免混淆)
    const allRecords = await Period.find({ user: req.user.id }).sort({ startDate: -1 }).limit(24);
    const cycleData = calculateCycleDetails(allRecords);
    
    res.json({
      records: allRecords,
      ...cycleData
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * PUT /api/period/:id
 * 修改记录 (管理员可改所有，普通用户只改自己)
 */
router.put("/:id", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note } = req.body;
  
  try {
    // 构建查询条件
    let query = { _id: req.params.id };
    // 如果不是管理员，限制只能改自己的
    if (req.user.role !== 'super_admin') {
      query.user = req.user.id;
    }

    const record = await Period.findOne(query);
    if (!record) {
      return res.status(404).json({ msg: "记录不存在或无权修改" });
    }

    // 更新字段
    if (startDate) record.startDate = startDate;
    if (endDate) record.endDate = endDate;
    if (symptoms) record.symptoms = symptoms;
    if (flow) record.flow = flow;
    if (note) record.note = note;

    if (endDate && startDate) {
       record.duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    await record.save();

    // 返回最新数据 (这里为了体验，返回当前用户能看到的数据列表)
    // 如果是管理员修改了别人的，看到的列表会包含所有人的
    let listQuery = {};
    if (req.user.role !== 'super_admin') {
        listQuery = { user: req.user.id };
    }

    const allRecords = await Period.find(listQuery)
        .sort({ startDate: -1 })
        .limit(24)
        .populate('user', 'displayName');
    const cycleData = calculateCycleDetails(allRecords);

    res.json({
      records: allRecords,
      ...cycleData
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * DELETE /api/period/:id
 * 删除记录 (管理员可删所有，普通用户只删自己)
 */
router.delete("/:id", auth, checkPrivate, async (req, res) => {
    try {
        let query = { _id: req.params.id };
        
        // 🔥 权限控制
        if (req.user.role !== 'super_admin') {
            query.user = req.user.id;
        }

        const deleted = await Period.findOneAndDelete(query);
        
        if (!deleted) {
            return res.status(404).json({ msg: "记录不存在或无权删除" });
        }

        logOperation({
            operatorId: req.user.id,
            action: "DELETE_PERIOD",
            target: "PeriodTracker",
            details: { id: req.params.id },
            ip: req.ip,
            io: req.app.get('socketio')
        });

        res.json({ msg: "Deleted" });
    } catch (e) { 
        console.error(e);
        res.status(500).send("Error"); 
    }
});

module.exports = router;