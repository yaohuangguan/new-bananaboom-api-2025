const router = require("express").Router();
const Period = require("../models/Period");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate"); 
const logOperation = require("../utils/audit");
const dayjs = require("dayjs"); // 🔥 替换 moment

// --- 核心算法：全套周期预测 (Day.js 版) ---
const calculateCycleDetails = (records) => {
  // 1. 默认值兜底
  let avgCycle = 28;
  let avgDuration = 5;

  if (records && records.length >= 2) {
    const recent = records.slice(0, 6);
    
    // 计算平均周期 (排除异常值)
    const validCycles = recent.filter(r => r.cycleLength > 20 && r.cycleLength < 45);
    if (validCycles.length > 0) {
      const totalDays = validCycles.reduce((sum, r) => sum + r.cycleLength, 0);
      avgCycle = Math.round(totalDays / validCycles.length);
    }
    
    // 计算平均持续天数
    const validDurations = recent.filter(r => r.duration > 2 && r.duration < 10);
    if (validDurations.length > 0) {
      const totalDur = validDurations.reduce((sum, r) => sum + r.duration, 0);
      avgDuration = Math.round(totalDur / validDurations.length);
    }
  }

  // 2. 确定基准日期 (最近一次开始时间)
  const lastRecord = records[0];
  const lastStart = lastRecord ? dayjs(lastRecord.startDate) : dayjs();

  // 3. --- 预测关键节点 ---
  // 注意：Day.js 是不可变的，链式调用会返回新对象，非常安全
  
  // A. 下次姨妈日
  const nextPeriodDate = lastStart.add(avgCycle, 'day');

  // B. 排卵日 (下次姨妈 - 14天)
  const ovulationDate = nextPeriodDate.subtract(14, 'day');

  // C. 排卵期/易孕期 (排卵日前5天 ~ 后4天)
  const fertileStart = ovulationDate.subtract(5, 'day');
  const fertileEnd = ovulationDate.add(4, 'day');

  return {
    avgCycle,
    avgDuration,
    lastStart: lastStart.toDate(),
    prediction: {
      nextPeriodStart: nextPeriodDate.toDate(),
      ovulationDate: ovulationDate.toDate(),
      // 易孕期范围
      fertileWindow: {
        start: fertileStart.toDate(),
        end: fertileEnd.toDate()
      },
      // 格式化输出方便调试或前端直接展示
      desc: `预计 ${nextPeriodDate.format('MM-DD')} 来姨妈，${fertileStart.format('MM-DD')} 到 ${fertileEnd.format('MM-DD')} 是排卵期。`
    }
  };
};

/**
 * GET /api/period
 * 获取列表 + 预测数据
 */
router.get("/", auth, checkPrivate, async (req, res) => {
  try {
    const records = await Period.find({ user: req.user.id })
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
 * 新增记录
 */
router.post("/", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note } = req.body;
  const userId = req.user.id;

  try {
    // 1. 找上一次记录计算周期
    const lastRecord = await Period.findOne({ user: userId }).sort({ startDate: -1 });
    let cycleLength = 0;
    
    // Day.js 的 diff 用法：dayjs(A).diff(dayjs(B), 'day')
    if (lastRecord) {
      cycleLength = dayjs(startDate).diff(dayjs(lastRecord.startDate), 'day');
    }

    // 2. 计算持续时长
    let duration = 5; 
    if (endDate) {
      // 记得 +1，因为 1号到1号算1天，diff 是 0
      duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    const newPeriod = new Period({
      user: userId,
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
      operatorId: userId,
      action: "ADD_PERIOD",
      target: "PeriodTracker",
      details: { date: startDate, cycleLength },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回最新数据
    const allRecords = await Period.find({ user: userId }).sort({ startDate: -1 }).limit(24);
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
 * 更新记录
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

    // 重新计算 duration
    // 这里如果只更新了 endDate，需要查库拿原来的 startDate，
    // 但为了性能，建议前端修改时把 startDate 和 endDate 一起传过来
    if (endDate && startDate) {
       updateFields.duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    await Period.findByIdAndUpdate(req.params.id, { $set: updateFields });

    const allRecords = await Period.find({ user: req.user.id }).sort({ startDate: -1 }).limit(24);
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
        res.json({ msg: "Deleted" });
    } catch (e) { res.status(500).send("Error"); }
});

module.exports = router;