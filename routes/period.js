const router = require("express").Router();
const Period = require("../models/Period");
const User = require("../models/User"); 
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
 * 获取记录 
 * 支持 query 参数: ?targetUserId=xxx
 * (管理员可以查看特定用户的记录，不传则看所有或自己)
 */
router.get("/", auth, checkPrivate, async (req, res) => {
  try {
    let query = {};
    const { targetUserId } = req.query; // 🔥 支持前端筛选

    if (req.user.role === 'super_admin') {
      // 👑 管理员模式
      if (targetUserId) {
        // 如果指定了看谁，就只看那个人的 (比如只看老婆的)
        query = { user: targetUserId };
      } else {
        // 没指定，就看所有人 (全家总览)
        query = {}; 
      }
    } else {
      // 👩 普通模式：强制只看自己，忽略 targetUserId
      query = { user: req.user.id };
    }

    const records = await Period.find(query)
      .sort({ startDate: -1 })
      .limit(24)
      .populate('user', 'displayName photoURL email'); 

    // 如果是查单人的，计算的数据才准确；如果是查多人的，这个 cycleData 只有参考意义
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
 * 新增记录 (支持代打卡)
 * Body: { ..., targetUserId: "xxx" }
 */
router.post("/", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note, targetUserId } = req.body;

  try {
    // 🔥 1. 确定“目标用户”是谁
    let finalUserId = req.user.id; // 默认是自己

    // 如果前端传了目标ID，且当前操作者是管理员 -> 允许代打卡
    if (targetUserId && req.user.role === 'super_admin') {
      finalUserId = targetUserId;
    }

    // 2. 找目标用户的上一条记录 (计算周期)
    const lastRecord = await Period.findOne({ user: finalUserId }).sort({ startDate: -1 });
    
    let cycleLength = 0;
    if (lastRecord) {
      cycleLength = dayjs(startDate).diff(dayjs(lastRecord.startDate), 'day');
    }

    let duration = 5; 
    if (endDate) {
      duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    const newPeriod = new Period({
      user: finalUserId,       // 🔥 记录归属：可能是老婆
      operator: req.user.id,   // 🔥 操作记录：绝对是你 (审计用)
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
      details: { 
        date: startDate, 
        cycleLength, 
        owner: finalUserId, 
        isProxy: finalUserId !== req.user.id // 标记是否为代打卡
      },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 3. 返回数据：务必返回“目标用户”的最新列表
    // 这样前端界面刷新后，看到的是老婆的数据更新了，而不是你的
    const allRecords = await Period.find({ user: finalUserId }).sort({ startDate: -1 }).limit(24);
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
 * 修改记录 (管理员可改任何人)
 */
router.put("/:id", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note } = req.body;
  
  try {
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

    // 记录是谁修改的
    record.operator = req.user.id;

    await record.save();

    // 返回被修改者的最新列表
    const allRecords = await Period.find({ user: record.user })
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
 */
router.delete("/:id", auth, checkPrivate, async (req, res) => {
    try {
        let query = { _id: req.params.id };
        
        if (req.user.role !== 'super_admin') {
            query.user = req.user.id;
        }

        const deleted = await Period.findOneAndDelete(query);
        
        if (!deleted) {
            return res.status(404).json({ msg: "记录不存在或无权删除" });
        }

        res.json({ msg: "Deleted" });
    } catch (e) { 
        res.status(500).send("Error"); 
    }
});

module.exports = router;