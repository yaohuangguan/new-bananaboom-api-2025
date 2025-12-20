const router = require("express").Router();
const Period = require("../models/Period");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate"); 
const logOperation = require("../utils/audit");
const dayjs = require("dayjs");


/**
 * --- 🧠 优化后的加权预测算法 ---
 * 目的：通过对近期数据赋予更高权重，更精准地捕捉用户生理周期的变化趋势。
 * 逻辑：
 * 1. 过滤：排除掉小于21天或大于40天的异常周期，防止因疾病或压力导致的极端误差。
 * 2. 加权：最近3次周期按 3:2:1 比例计算（最近一次占比50%），使预测更贴近当下身体状况。
 * 3. 统计：经期时长（Duration）采用中位数，防止偶尔忘记打卡导致的长数据干扰。
 */
const calculateCycleDetails = (records) => {
  let finalCycle = 28; // 默认周期
  let avgDuration = 5; // 默认经期时长

  if (records && records.length >= 1) {
    // 取最近12条记录作为分析样本
    const recentAll = records.slice(0, 12);
    
    // 筛选出 21-40 天之间的有效正常周期
    const validCycles = recentAll.filter(r => r.cycleLength >= 21 && r.cycleLength <= 40);

    if (validCycles.length > 0) {
      if (validCycles.length < 3) {
        // 样本不足3个时，采用简单平均值
        const total = validCycles.reduce((sum, r) => sum + r.cycleLength, 0);
        finalCycle = Math.round(total / validCycles.length);
      } else {
        // 样本充足，采用【加权移动平均】：(最近*3 + 次近*2 + 较远*1) / 6
        const top3 = validCycles.slice(0, 3); 
        const weightedSum = (top3[0].cycleLength * 3) + (top3[1].cycleLength * 2) + (top3[2].cycleLength * 1);
        finalCycle = Math.round(weightedSum / 6);
      }
    }

    // 计算经期持续天数的中位数，过滤掉非正常天数
    const validDurations = recentAll
        .filter(r => r.duration >= 3 && r.duration <= 8)
        .map(r => r.duration)
        .sort((a, b) => a - b);
    
    if (validDurations.length > 0) {
      const mid = Math.floor(validDurations.length / 2);
      avgDuration = validDurations.length % 2 !== 0 
        ? validDurations[mid] 
        : Math.round((validDurations[mid - 1] + validDurations[mid]) / 2);
    }
  }

  // 预测计算基准：以最后一次记录的开始日期为准
  const lastRecord = records[0];
  const lastStart = lastRecord ? dayjs(lastRecord.startDate) : dayjs();
  
  // 计算关键节点
  const nextPeriodDate = lastStart.add(finalCycle, 'day'); // 下次开始日期
  const ovulationDate = nextPeriodDate.subtract(14, 'day'); // 理论排卵日
  const fertileStart = ovulationDate.subtract(5, 'day');   // 易孕期开始
  const fertileEnd = ovulationDate.add(4, 'day');         // 易孕期结束

  return {
    avgCycle: finalCycle,
    avgDuration,
    lastStart: lastStart.toDate(),
    prediction: {
      nextPeriodStart: nextPeriodDate.toDate(),
      ovulationDate: ovulationDate.toDate(),
      fertileWindow: { start: fertileStart.toDate(), end: fertileEnd.toDate() },
      desc: `预计 ${nextPeriodDate.format('MM-DD')} 左右开启新周期 (最近趋势：${finalCycle}天)。`
    }
  };
};

/**
 * @route   GET /api/period
 * @desc    获取经期记录列表
 * @access  Private
 * 权限：super_admin 可查看指定 targetUserId 或全量数据；普通用户仅限查看自己。
 */
router.get("/", auth, checkPrivate, async (req, res) => {
  try {
    let query = {};
    const { targetUserId } = req.query;

    if (req.user.role === 'super_admin') {
      // 如果管理员指定了用户ID则查询特定人，否则查询全部
      query = targetUserId ? { user: targetUserId } : {}; 
    } else {
      // 非管理员强制锁定为当前登录用户
      query = { user: req.user.id };
    }

    const records = await Period.find(query)
      .sort({ startDate: -1 })
      .limit(24)
      .populate('user', 'displayName photoURL'); // 关联查询用户信息用于前端头像显示

    // 计算预测模型数据
    const cycleData = calculateCycleDetails(records);

    res.json({ records, ...cycleData });
  } catch (err) {
    res.status(500).send("获取记录失败");
  }
});

/**
 * @route   POST /api/period
 * @desc    新增经期记录 (支持管理员代打卡)
 */
router.post("/", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note, targetUserId, color } = req.body;

  try {
    // 1. 确定数据归属权
    let finalUserId = req.user.id;
    // 如果管理员指定了 targetUserId，则将记录存入该用户名下
    if (targetUserId && req.user.role === 'super_admin') {
      finalUserId = targetUserId;
    }

    // 2. 获取目标用户的前一条记录，用于计算本次记录的周期长度（cycleLength）
    const lastRecord = await Period.findOne({ user: finalUserId }).sort({ startDate: -1 });
    
    let cycleLength = 0;
    if (lastRecord) {
      cycleLength = dayjs(startDate).diff(dayjs(lastRecord.startDate), 'day');
    }

    // 3. 计算本次经期持续时长
    let duration = 5; 
    if (endDate) {
      duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    // 4. 创建并保存记录
    const newPeriod = new Period({
      user: finalUserId,       // 所属者
      operator: req.user.id,   // 实际操作者（审计用）
      startDate,
      endDate,
      duration,
      cycleLength,
      symptoms,
      flow,
      note,
      color: color || "RED_DARK" // 存入对应的颜色 Code
    });

    await newPeriod.save();

    // 5. 记录操作审计日志
    logOperation({
      operatorId: req.user.id,
      action: "ADD_PERIOD",
      target: "PeriodTracker",
      details: { date: startDate, owner: finalUserId, color, isProxy: finalUserId !== req.user.id },
      ip: req.ip,
      io: req.app.get('socketio')
    });

    // 返回被操作人的最新全量列表及预测数据，确保前端同步刷新
    const allRecords = await Period.find({ user: finalUserId }).sort({ startDate: -1 }).limit(24);
    const cycleData = calculateCycleDetails(allRecords);
    
    res.json({ records: allRecords, ...cycleData });

  } catch (err) {
    res.status(500).send("创建记录失败");
  }
});

/**
 * @route   PUT /api/period/:id
 * @desc    修改经期记录
 */
router.put("/:id", auth, checkPrivate, async (req, res) => {
  const { startDate, endDate, symptoms, flow, note, color } = req.body;
  
  try {
    let query = { _id: req.params.id };
    // 越权校验：非管理员只能修改属于自己的数据
    if (req.user.role !== 'super_admin') { query.user = req.user.id; }

    const record = await Period.findOne(query);
    if (!record) return res.status(404).json({ msg: "未找到相关记录或无权操作" });

    // 逐一更新字段
    if (startDate) record.startDate = startDate;
    if (endDate) record.endDate = endDate;
    if (symptoms) record.symptoms = symptoms;
    if (flow) record.flow = flow;
    if (note) record.note = note;
    if (color) record.color = color;

    // 重新计算时长
    if (endDate && startDate) {
       record.duration = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
    }

    await record.save();

    // 返回所属者的最新列表
    const allRecords = await Period.find({ user: record.user }).sort({ startDate: -1 }).limit(24).populate('user', 'displayName');
    const cycleData = calculateCycleDetails(allRecords);

    res.json({ records: allRecords, ...cycleData });
  } catch (err) {
    res.status(500).send("更新记录失败");
  }
});

/**
 * @route   DELETE /api/period/:id
 */
router.delete("/:id", auth, checkPrivate, async (req, res) => {
    try {
        let query = { _id: req.params.id };
        // 越权校验
        if (req.user.role !== 'super_admin') { query.user = req.user.id; }

        const deleted = await Period.findOneAndDelete(query);
        if (!deleted) return res.status(404).json({ msg: "未找到记录" });

        res.json({ msg: "记录已删除" });
    } catch (e) { res.status(500).send("删除失败"); }
});

module.exports = router;