const router = require("express").Router();
const Period = require("../models/Period");
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
 * 获取全局共享的记录
 */
router.get("/", auth, checkPrivate, async (req, res) => {
  try {
    // 🔥 核心修改：移除 { user: ... } 过滤条件
    // 只要有权限的人，看到的数据都是同一份
    const records = await Period.find({})
      .sort({ startDate: -1 })
      .limit(24);

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
 * 新增记录 (任何人加的都算在公共账本上)
 */
router.post("/", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note } = req.body;

  try {
    // 1. 找上一条记录 (全局最新的那条)
    const lastRecord = await Period.findOne({}).sort({ startDate: -1 });
    
    let cycleLength = 0;
    if (lastRecord) {
      cycleLength = dayjs(startDate).diff(dayjs(lastRecord.startDate), 'day');
    }

    let duration = 5; 
    if (endDate) {
      duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    const newPeriod = new Period({
      operator: req.user.id, // 记录是谁录入的，但不影响显示
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
      action: "ADD_PERIOD_SHARED",
      target: "PeriodTracker",
      details: { date: startDate, cycleLength },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新全量数据
    const allRecords = await Period.find({}).sort({ startDate: -1 }).limit(24);
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
 * 修改记录
 */
router.put("/:id", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note } = req.body;
  
  try {
    const updateFields = {};
    if (startDate) updateFields.startDate = startDate;
    if (endDate) updateFields.endDate = endDate;
    if (symptoms) updateFields.symptoms = symptoms;
    if (flow) updateFields.flow = flow;
    if (note) updateFields.note = note;

    if (endDate && startDate) {
       updateFields.duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    // 只需要 ID 匹配即可，不检查 user，实现“谁都能改”
    await Period.findByIdAndUpdate(req.params.id, { $set: updateFields });

    const allRecords = await Period.find({}).sort({ startDate: -1 }).limit(24);
    const cycleData = calculateCycleDetails(allRecords);

    res.json({
      records: allRecords,
      ...cycleData
    });
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

/**
 * DELETE /api/period/:id
 */
router.delete("/:id", auth, checkPrivate, async (req, res) => {
    try {
        await Period.findByIdAndDelete(req.params.id);
        
        logOperation({
            operatorId: req.user.id,
            action: "DELETE_PERIOD_SHARED",
            target: "PeriodTracker",
            details: { id: req.params.id },
            ip: req.ip,
            io: req.app.get('socketio')
        });

        res.json({ msg: "Deleted" });
    } catch (e) { res.status(500).send("Error"); }
});

module.exports = router;