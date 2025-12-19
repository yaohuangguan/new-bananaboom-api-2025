const express = require("express");
const router = express.Router();
const Menu = require("../models/Menu");
const Fitness = require("../models/Fitness");
const User = require('../models/User')
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate"); // 你的私域权限中间件
const dayjs = require("dayjs");

// 🔥 全局路由守卫：只有登录且通过 checkPrivate (VIP/家人) 的用户才能访问
router.use(auth, checkPrivate);

/**
 * @route   GET /api/menu
 * @desc    获取转盘菜品列表 (支持多种过滤模式)
 * @access  Private (VIP)
 * * @param {string} category - (可选) 按分类筛选，例如 "晚餐"
 * @param {string} cooldown - (可选) "true" 开启贤者模式。过滤掉最近 2 天吃过的菜。
 * @param {string} healthy  - (可选) "true" 开启健康模式。过滤掉高热量 (high) 的菜。
 * * @example 请求示例:
 * GET /api/menu?category=晚餐&cooldown=true&healthy=true
 */
router.get("/", async (req, res) => {
  try {
    const { category, cooldown, healthy } = req.query;
    
    // 基础查询：只查找状态为“启用”的菜品
    let query = { isActive: true };

    // 1. 分类筛选
    if (category) query.category = category;

    // 2. 🔥 功能 A：贤者模式 (Cooldown Mode)
    // 业务逻辑：如果开启，过滤掉 `lastEaten` 在 48 小时内的记录。
    // 即：只返回 "很久没吃" 或 "从未吃过" 的菜。
    if (cooldown === 'true') {
      const twoDaysAgo = dayjs().subtract(2, 'days').toDate();
      query.$or = [
        { lastEaten: { $lte: twoDaysAgo } }, // 上次吃是在2天前
        { lastEaten: { $eq: null } },        // 从没吃过
        { lastEaten: { $exists: false } }
      ];
    }

    // 3. 🔥 功能 B：健康模式 (Healthy Mode)
    // 业务逻辑：如果开启，过滤掉 `caloriesLevel` 为 'high' 的记录。
    if (healthy === 'true') {
      query.caloriesLevel = { $in: ['low', 'medium'] };
    }

    // 排序：优先展示很久没吃的 (lastEaten 升序)
    const menus = await Menu.find(query).sort({ lastEaten: 1 });
    res.json(menus);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * @route   POST /api/menu
 * @desc    新增一道菜到公共菜单
 * @access  Private (VIP)
 * * @body {string} name - 菜名 (必须)
 * @body {string} category - 分类 (默认: 随机)
 * @body {string} caloriesLevel - 卡路里等级: 'low' | 'medium' | 'high'
 * @body {Array} tags - 标签数组
 * @body {number} weight - 权重 1-10
 */
router.post("/", async (req, res) => {
  try {
    const { name, category, tags, image, weight, caloriesLevel } = req.body;
    
    // 查重：全库菜名唯一
    const exists = await Menu.findOne({ name });
    if (exists) return res.status(400).json({ msg: "这道菜已经在菜单里啦" });

    const newMenu = new Menu({
      createdBy: req.user.id,
      name,
      category,
      tags,
      image,
      weight,
      caloriesLevel
    });

    await newMenu.save();
    res.json(newMenu);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// 标准 CRUD: 修改菜品
router.put("/:id", async (req, res) => {
  try {
    const updated = await Menu.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    res.json(updated);
  } catch (err) { res.status(500).send("Error"); }
});

// 标准 CRUD: 删除菜品
router.delete("/:id", async (req, res) => {
  try {
    await Menu.findByIdAndDelete(req.params.id);
    res.json({ msg: "Deleted" });
  } catch (err) { res.status(500).send("Error"); }
});

/**
 * @route   POST /api/menu/confirm/:id
 * @desc    🔥 确认选择这道菜 (核心业务接口)
 * @access  Private (VIP)
 * * @body {string} mealTime - (可选) 用餐时段标签，如 "晚餐", "午餐"。用于生成更好看的日记。
 * * 业务逻辑：
 * 1. 全局：更新 Menu 表的 `lastEaten` 为当前时间 (触发全家人的贤者模式冷却)。
 * 2. 个人：在当前用户的 Fitness 表今天的记录中，追加一条饮食记录 (Diet)。
 * 3. 自动：如果菜名含“汤”，自动给 Fitness 增加 300ml 饮水记录。
 */
router.post("/confirm/:id", async (req, res) => {
  const menuId = req.params.id;
  const userId = req.user.id;
  const todayStr = dayjs().format("YYYY-MM-DD");
  const { mealTime } = req.body; 
  const timeLabel = mealTime || "大厨转盘"; // 默认文案

  try {
    // 1. 更新全局菜品状态
   // 获取 用户信息(为了拿 goal 记录日志) 和 菜品信息
   const [currentUser, menuItem] = await Promise.all([
    User.findById(userId),
    Menu.findById(menuId)
  ]);
    if (!menuItem) return res.status(404).json({ msg: "菜品不存在" });

    menuItem.timesEaten += 1;
    menuItem.lastEaten = new Date(); // 更新全局 CD
    await menuItem.save();

    // 2. 写入个人 Fitness 记录
    let fitnessRecord = await Fitness.findOne({ user: userId, dateStr: todayStr });
    
    // 如果今天还没记录，先创建一条空的
    if (!fitnessRecord) {
      fitnessRecord = new Fitness({
        user: userId,
        date: new Date(),
        dateStr: todayStr,
        diet: { content: "", water: 0 }
      });
    }

    // 🔥 仅仅是记录：当时用户处于什么模式
    // 这不会影响转盘逻辑，只是为了以后在 Fitness 页面看历史记录时知道当时在干嘛
    const currentGoal = currentUser.fitnessGoal || 'maintain';
    fitnessRecord.diet.goalSnapshot = currentGoal;


    // 🔥 生成 AI 风格的饮食日记
    const newContent = `${timeLabel}选中了：【${menuItem.name}】。`;
    const oldContent = fitnessRecord.diet.content || "";
    // 追加内容 (换行显示)
    fitnessRecord.diet.content = oldContent ? `${oldContent}\n${newContent}` : newContent;

    // 🔥 自动补水逻辑 (Feature D)
    const isSoup = menuItem.name.includes("汤") || (menuItem.tags && menuItem.tags.some(t => t.includes("汤")));
    if (isSoup) {
      fitnessRecord.diet.water = (fitnessRecord.diet.water || 0) + 300;
      fitnessRecord.diet.content += " (汤品自动补水 +300ml)";
    }

    await fitnessRecord.save();

    res.json({ 
      msg: `已选定【${menuItem.name}】，并同步到您的饮食记录。`,
      menu: menuItem,
      fitness: fitnessRecord
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;