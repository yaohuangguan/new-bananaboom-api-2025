const express = require("express");
const router = express.Router();
const Menu = require("../models/Menu");
const Fitness = require("../models/Fitness");
const User = require("../models/User"); 
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate"); // 私域权限检查
const dayjs = require("dayjs");
const { generateJSON } = require("../utils/aiProvider"); // 刚才封装好的 AI 工具

// 🔥 全局路由守卫：只有登录且是 VIP (家人) 才能访问
router.use(auth, checkPrivate);

/**
 * =================================================================
 * 1. 获取全量菜品列表 (管理视图)
 * =================================================================
 * @route   GET /api/menu
 * @desc    获取所有启用的菜品，不进行任何算法过滤。
 * @usage   用于前端的“菜单管理”页面，展示列表供用户查看或编辑。
 * * @param   {string} category - (Query可选) 按分类筛选，如 "晚餐"
 * @returns {Array} 菜品对象数组
 */
router.get("/", async (req, res) => {
  try {
    const { category } = req.query;
    
    // 基础查询：只查找状态为 isActive=true 的
    let query = { isActive: true };
    if (category) query.category = category;

    // 按创建时间倒序排列 (新加的菜在最上面)
    const menus = await Menu.find(query).sort({ createdAt: -1 });
    res.json(menus);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * =================================================================
 * 🥗 智能膳食推荐接口 (基于用户真实数据)
 * =================================================================
 * @route   POST /api/menu/recommend
 * @desc    根据用户最新体重、健身目标模式，推荐 3 道适合的菜品
 * @access  Private
 */
router.post("/recommend", auth, async (req, res) => {
    try {
      const userId = req.user.id;
  
      // 1. 并行查询：查用户基础信息 & 查最近一次的 Fitness 记录
      const [userProfile, latestFitness] = await Promise.all([
        User.findById(userId).select("fitnessGoal displayName"), 
        Fitness.findOne({ user: userId }).sort({ date: -1 }) // 按日期倒序取最新一条
      ]);
  
      // 2. 数据清洗与逻辑判断
      // 目标优先级：Fitness记录里的当天模式 > User表里的长期目标 > 默认 maintain
      let currentGoal = "maintain"; 
      let currentWeight = null;
      
      // 尝试从 Fitness 表获取最新状态
      if (latestFitness) {
        if (latestFitness.diet && latestFitness.diet.goalSnapshot) {
          currentGoal = latestFitness.diet.goalSnapshot;
        }
        if (latestFitness.body && latestFitness.body.weight) {
          currentWeight = latestFitness.body.weight;
        }
      }
  
      // 如果 Fitness 表里没记模式，回退到 User 表
      if (currentGoal === "maintain" && userProfile.fitnessGoal) {
        currentGoal = userProfile.fitnessGoal;
      }
  
      // 3. 构造 AI 上下文 (User Context)
      let userContext = `用户昵称: ${userProfile.displayName || "健身爱好者"}。`;
      
      if (currentWeight) {
        userContext += ` 最新体重: ${currentWeight}kg。`;
      }
      
      // 翻译目标模式给 AI 理解
      const goalMap = {
        cut: "减脂 (Fat Loss) - 需要低热量、高饱腹感、高蛋白",
        bulk: "增肌 (Muscle Gain) - 需要热量盈余、高碳水、高蛋白",
        maintain: "保持体型 (Maintain) - 营养均衡"
      };
      userContext += ` 当前健身目标: ${goalMap[currentGoal] || goalMap.maintain}。`;
  
      console.log(`🥗 [Menu Recommend] Context: ${userContext}`);
  
      // 4. 构造 Prompt
      const systemPrompt = `
        你是一位专业的运动营养师。请根据以下用户的身体数据和健身目标，推荐 3 道适合的正餐（午餐或晚餐）。
        
        【用户信息】：${userContext}
  
        【要求】：
        1. 必须严格贴合用户的健身目标（例如：如果是减脂，请严格控制碳水和脂肪；如果是增肌，请保证足够的碳水和蛋白质）。
        2. 菜品要是家常能做的，不要过于花哨。
        3. 请严格按照以下 JSON 格式返回：
        {
          "nutrition_advice": "一句话点评用户的当前状态并给出营养建议（如：'您当前处于减脂期，建议多吃膳食纤维...'）",
          "dishes": [
            {
              "name": "菜品名称",
              "tags": ["高蛋白", "低脂", "快手"],
              "calories_estimate": "预估热量(如: 400kcal)",
              "reason": "为什么推荐这道菜(结合用户目标说明)"
            },
            { ... },
            { ... }
          ]
        }
      `;
  
      // 5. 调用 AI
      // 这里的 modelName 使用默认配置 (gemini-3-flash-preview)
      const data = await generateJSON(systemPrompt);
  
      // 6. 返回结果
      res.json({
        success: true,
        // 把刚才用于判断的依据也返回给前端，方便 UI 展示“基于您的xxkg体重推荐”
        based_on: {
          weight: currentWeight,
          goal: currentGoal,
          source: latestFitness ? "fitness_record" : "user_profile"
        },
        recommendation: data
      });
  
    } catch (err) {
      console.error("Menu Recommend Error:", err);
      res.status(500).json({ msg: "营养师正在忙，请稍后再试" });
    }
  });

/**
 * =================================================================
 * 2. 🔥 随机抽取接口 (转盘核心算法)
 * =================================================================
 * @route   GET /api/menu/draw
 * @desc    根据前端传入的开关，在后端进行过滤和带权重的随机抽取。
 * @usage   用于转盘页面。前端调用此接口获取数据来渲染转盘，并直接知道结果。
 * * @param   {string} category - (Query) "午餐" | "晚餐"
 * @param   {string} cooldown - (Query) "true" = 开启贤者模式 (过滤掉最近2天吃过的)
 * @param   {string} healthy  - (Query) "true" = 开启健康模式 (过滤掉 high 热量的)
 * * @returns {Object} JSON结构:
 * {
 * "winner": { ... },   // 最终中奖的菜品对象 (转盘动画应该停在这里)
 * "pool": [ ... ],     // 参与抽奖的候选菜品列表 (用于渲染转盘的扇形)
 * "meta": { ... }      // 调试元数据
 * }
 */
router.get("/draw", async (req, res) => {
  try {
    const { category, cooldown, healthy } = req.query;
    
    // --- Step 1: 构建过滤条件 ---
    let query = { isActive: true };

    // 筛选分类
    if (category) query.category = category;

    // A. 贤者模式 (冷却逻辑)
    // 逻辑：lastEaten 必须小于 48小时前，或者 为空(从未吃过)
    if (cooldown === 'true') {
      const twoDaysAgo = dayjs().subtract(2, 'days').toDate();
      query.$or = [
        { lastEaten: { $lte: twoDaysAgo } },
        { lastEaten: { $eq: null } },
        { lastEaten: { $exists: false } }
      ];
    }

    // B. 健康模式 (热量过滤)
    // 逻辑：只保留 low 和 medium，排除 high
    if (healthy === 'true') {
      query.caloriesLevel = { $in: ['low', 'medium'] };
    }

    // --- Step 2: 获取候选池 ---
    const candidates = await Menu.find(query);

    if (candidates.length === 0) {
      return res.status(404).json({ msg: "没有符合条件的菜品，请尝试关闭一些过滤开关" });
    }

    // --- Step 3: 带权重的随机算法 (Weighted Random) ---
    // 逻辑：weight (1-10) 越高，被抽中的概率越大 (扇形面积越大)
    
    // 3.1 计算总权重
    let totalWeight = 0;
    candidates.forEach(item => {
      totalWeight += (item.weight || 1);
    });

    // 3.2 生成随机数 (0 到 totalWeight 之间)
    let random = Math.random() * totalWeight;
    
    // 3.3 寻找中奖者
    let winner = null;
    for (const item of candidates) {
      const w = item.weight || 1;
      if (random < w) {
        winner = item; // 命中
        break;
      }
      random -= w; // 减去当前权重，继续下一轮检测
    }
    
    // 兜底：如果因浮点数精度问题没选中，默认选最后一个
    if (!winner) winner = candidates[candidates.length - 1];

    // --- Step 4: 返回结果 ---
    res.json({
      winner: winner,  // 前端用这个控制停止位置
      pool: candidates, // 前端用这个渲染转盘 UI
      meta: {
        totalCandidates: candidates.length,
        filterMode: { cooldown, healthy }
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/**
 * =================================================================
 * 3. 新增菜品
 * =================================================================
 * @route   POST /api/menu
 * @body    { name, category, tags, weight, caloriesLevel, image }
 */
router.post("/", async (req, res) => {
  try {
    const { name, category, tags, image, weight, caloriesLevel } = req.body;
    
    // 查重
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

// 标准 CRUD: 修改
router.put("/:id", async (req, res) => {
  try {
    const updated = await Menu.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    res.json(updated);
  } catch (err) { res.status(500).send("Error"); }
});

// 标准 CRUD: 删除
router.delete("/:id", async (req, res) => {
  try {
    await Menu.findByIdAndDelete(req.params.id);
    res.json({ msg: "Deleted" });
  } catch (err) { res.status(500).send("Error"); }
});

/**
 * =================================================================
 * 4. 🔥 确认选择 (双重写入：全局冷却 + 个人记录)
 * =================================================================
 * @route   POST /api/menu/confirm/:id
 * @desc    用户在转盘结束后点击“确认”，记录数据。
 * @access  Private
 * * @body    {string} mealTime - (可选) 用餐时段，如 "午餐" 或 "晚餐"
 * * @logic
 * 1. Menu表：更新 `lastEaten` 为当前时间 (触发全家冷却)。
 * 2. Fitness表：在当前用户的今日记录中，追加饮食内容。
 * 3. Auto-Water: 如果菜名含“汤”，自动 +300ml 水。
 */
router.post("/confirm/:id", async (req, res) => {
  const menuId = req.params.id;
  const userId = req.user.id;
  const todayStr = dayjs().format("YYYY-MM-DD");
  const { mealTime } = req.body; 

  try {
    const [currentUser, menuItem] = await Promise.all([
      User.findById(userId),
      Menu.findById(menuId)
    ]);

    if (!menuItem) return res.status(404).json({ msg: "菜品不存在" });

    // --- A. 更新全局菜单 (触发冷却) ---
    menuItem.timesEaten += 1;
    menuItem.lastEaten = new Date();
    await menuItem.save();

    // --- B. 写入个人 Fitness 记录 ---
    let fitnessRecord = await Fitness.findOne({ user: userId, dateStr: todayStr });
    
    // 如果今天还没记录，初始化一条
    if (!fitnessRecord) {
      fitnessRecord = new Fitness({
        user: userId,
        date: new Date(),
        dateStr: todayStr,
        diet: { content: "", water: 0 }
      });
    }

    // 记录当时的模式快照 (Cut/Bulk) - 仅做记录，不影响转盘逻辑
    const currentGoal = currentUser.fitnessGoal || 'maintain';
    fitnessRecord.diet.goalSnapshot = currentGoal;

    // 生成日记文案
    // 格式： "晚餐选中了：【红烧肉】。"
    const newContent = `${mealTime || '大厨转盘'}选中了：【${menuItem.name}】。`;
    const oldContent = fitnessRecord.diet.content || "";
    fitnessRecord.diet.content = oldContent ? `${oldContent}\n${newContent}` : newContent;

    // 自动补水逻辑
    const isSoup = menuItem.name.includes("汤") || (menuItem.tags && menuItem.tags.some(t => t.includes("汤")));
    if (isSoup) {
      fitnessRecord.diet.water = (fitnessRecord.diet.water || 0) + 300;
      fitnessRecord.diet.content += " (汤品自动补水 +300ml)";
    }

    await fitnessRecord.save();

    res.json({ 
      msg: `已确认【${menuItem.name}】，并记录到您的饮食日记`,
      menu: menuItem,
      fitness: fitnessRecord
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;