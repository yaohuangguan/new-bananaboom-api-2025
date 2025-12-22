import { Router } from 'express';
const router = Router();
import Menu from '../models/Menu.js';
import Fitness from '../models/Fitness.js';
import User from '../models/User.js';
import dayjs from 'dayjs';
import { generateJSON } from '../utils/aiProvider.js';

import { Types } from 'mongoose';

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
router.get('/', async (req, res) => {
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
    res.status(500).send('Server Error');
  }
});

/**
 * =================================================================
 * 🥗 智能膳食推荐接口 (Pro版 - 集成BMI分析)
 * =================================================================
 * @route   POST /api/menu/recommend
 * @desc    根据用户最新体重、BMI、健身目标，推荐 3 道适合的菜品
 * @access  Private
 */
router.post('/recommend', async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. 并行查询：基础档案 & 最新健身状态
    const [userProfile, latestFitness] = await Promise.all([
      User.findById(userId).select('fitnessGoal height displayName'),
      Fitness.findOne({ user: userId }).sort({ date: -1 }) // 找最近的一条记录
    ]);

    // ==========================================
    // 2. 智能数据组装 (Snapshot 优先策略)
    // ==========================================

    // A. 确定目标 (Fitness里的临时目标 > User里的长期目标 > 默认保持)
    let currentGoal = 'maintain';
    if (latestFitness && latestFitness.diet && latestFitness.diet.goalSnapshot) {
      currentGoal = latestFitness.diet.goalSnapshot;
    } else if (userProfile.fitnessGoal) {
      currentGoal = userProfile.fitnessGoal;
    }

    // B. 确定身体数据 (Fitness快照 > User基础数据)
    let currentWeight = latestFitness?.body?.weight || null;
    let currentHeight = latestFitness?.body?.height || userProfile.height || null;
    let currentBMI = latestFitness?.body?.bmi || null;

    // C. 如果数据库里没存 BMI 但有身高体重，我们现场算一下补救
    if (!currentBMI && currentWeight && currentHeight) {
      const h = currentHeight / 100;
      currentBMI = (currentWeight / (h * h)).toFixed(1);
    }

    // ==========================================
    // 3. 构建 AI 提示词 (Prompt Engineering)
    // ==========================================

    // 翻译目标给 AI
    const goalMap = {
      cut: '减脂/刷脂 (Fat Loss) - 需要制造热量缺口，高饱腹感',
      bulk: '增肌/增重 (Muscle Gain) - 需要热量盈余，高碳水高蛋白',
      maintain: '保持/塑形 (Maintain) - 营养均衡'
    };

    let userContext = `用户昵称: ${userProfile.displayName || '健身者'}。`;
    if (currentWeight) userContext += ` 当前体重: ${currentWeight}kg。`;
    if (currentHeight) userContext += ` 身高: ${currentHeight}cm。`;
    if (currentBMI) userContext += ` BMI指数: ${currentBMI}。`;
    userContext += ` 当前目标: ${goalMap[currentGoal] || goalMap.maintain}。`;

    console.log(`🥗 [AI Menu] Generating for: ${userContext}`);

    const systemPrompt = `
      你是一位拥有 20 年经验的运动营养专家。请根据用户的身体数据(BMI)和健身目标，推荐 3 道适合的正餐（午餐或晚餐）。要偏中式一些，2道中式1道西式。
      
      【用户信息】：
      ${userContext}

      【分析逻辑】：
      1. **先看 BMI**：
         - 如果 BMI > 24 (超重) 且目标是减脂：请严格控制碳水（推荐粗粮），增加膳食纤维。
         - 如果 BMI < 18.5 (偏瘦) 且目标是增肌：请推荐高密度热量食物，不用过于忌口油脂。
         - 如果 BMI 正常：重点在于蛋白质摄入和微量元素。
      2. **再看目标**：
         - Cut (减脂)：推荐 "低卡、抗饿" 的食物。
         - Bulk (增肌)：推荐 "易消化、高能量" 的食物。

      【输出要求】：
      请务必严格按照以下 JSON 格式返回，不要包含 Markdown 代码块：
      {
        "nutrition_advice": "针对用户当前BMI和目标的简短专业点评（例如：'您的BMI为24.5略微超重，结合减脂目标，建议本餐采用211饮食法...'）",
        "dishes": [
          {
            "name": "菜品名称 (如: 藜麦鸡胸沙拉)",
            "tags": ["高蛋白", "低GI", "快手"],
            "calories_estimate": "预估热量 (如: 450kcal)",
            "reason": "推荐理由 (结合BMI和目标的一句话解释)"
          },
          { ... },
          { ... }
        ]
      }
    `;

    // ==========================================
    // 4. 调用 AI & 返回
    // ==========================================
    const data = await generateJSON(systemPrompt); // 默认使用 gemini-3-flash-preview

    res.json({
      success: true,
      // 返回给前端展示用的“依据”，让用户知道是基于什么算的
      based_on: {
        weight: currentWeight,
        height: currentHeight,
        bmi: currentBMI,
        goal: currentGoal
      },
      recommendation: data
    });
  } catch (err) {
    console.error('Menu Recommend Error:', err);
    res.status(500).json({ msg: 'AI 营养师正在忙，请稍后再试' });
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
router.get('/draw', async (req, res) => {
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
      return res.status(404).json({ msg: '没有符合条件的菜品，请尝试关闭一些过滤开关' });
    }

    // --- Step 3: 带权重的随机算法 (Weighted Random) ---
    // 逻辑：weight (1-10) 越高，被抽中的概率越大 (扇形面积越大)

    // 3.1 计算总权重
    let totalWeight = 0;
    candidates.forEach((item) => {
      totalWeight += item.weight || 1;
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
      winner: winner, // 前端用这个控制停止位置
      pool: candidates, // 前端用这个渲染转盘 UI
      meta: {
        totalCandidates: candidates.length,
        filterMode: { cooldown, healthy }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

/**
 * =================================================================
 * 3. 新增菜品
 * =================================================================
 * @route   POST /api/menu
 * @body    { name, category, tags, weight, caloriesLevel, image }
 */
router.post('/', async (req, res) => {
  try {
    const { name, category, tags, image, weight, caloriesLevel } = req.body;

    // 查重
    const exists = await Menu.findOne({ name });
    if (exists) return res.status(400).json({ msg: '这道菜已经在菜单里啦' });

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
    res.status(500).send('Server Error');
  }
});

// 标准 CRUD: 修改
router.put('/:id', async (req, res) => {
  try {
    const updated = await Menu.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).send('Error');
  }
});

// 标准 CRUD: 删除
router.delete('/:id', async (req, res) => {
  try {
    await Menu.findByIdAndDelete(req.params.id);
    res.json({ msg: 'Deleted' });
  } catch (err) {
    res.status(500).send('Error');
  }
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
router.post('/confirm/:id', async (req, res) => {
  // 1. 获取并解码参数 (防止中文乱码)
  // 这里的 id 可能是 "65a..." (数据库ID) 也可能是 "红烧牛肉" (AI生成的菜名)
  const paramId = decodeURIComponent(req.params.id);
  const userId = req.user.id;
  const todayStr = dayjs().format('YYYY-MM-DD');
  const { mealTime } = req.body;

  try {
    // 2. 先查用户 (User 是必须要查的，为了拿 fitnessGoal)
    const currentUser = await User.findById(userId);
    if (!currentUser) return res.status(404).json({ msg: '用户未找到' });

    // 3. 核心分叉逻辑：判断 paramId 到底是个 ID 还是个菜名
    let menuItem = null;
    let finalDishName = '';
    let isSoup = false;

    // 判断逻辑：是合法的 ObjectId 格式吗？
    if (Types.ObjectId.isValid(paramId)) {
      // ---> 分支 A: 看起来像个 ID，去 Menu 表查查看
      menuItem = await Menu.findById(paramId);
    }

    if (menuItem) {
      // [情况 1]: 是现有菜单 (数据库里查到了)
      finalDishName = menuItem.name;

      // --- A. 更新全局菜单 (触发冷却) ---
      // 只有数据库里的菜才需要更新"上次吃的时间"
      menuItem.timesEaten += 1;
      menuItem.lastEaten = new Date();
      await menuItem.save();

      // 判断是否汤品 (查 tags 或 名字)
      isSoup = menuItem.name.includes('汤') || (menuItem.tags && menuItem.tags.some((t) => t.includes('汤')));
    } else {
      // [情况 2]: 是 AI 菜品 (不是 ID，或者库里没这个 ID)
      // 直接把 paramId 当作菜名
      finalDishName = paramId;

      // 判断是否汤品 (只能查名字)
      isSoup = finalDishName.includes('汤');
    }

    // --- B. 写入个人 Fitness 记录 (通用逻辑) ---
    // 这里的逻辑对 AI 菜品和现有菜品是通用的，只认 finalDishName

    let fitnessRecord = await Fitness.findOne({ user: userId, dateStr: todayStr });

    // 如果今天还没记录，初始化一条
    if (!fitnessRecord) {
      fitnessRecord = new Fitness({
        user: userId,
        date: new Date(),
        dateStr: todayStr,
        diet: { content: '', water: 0 },
        body: {}, // 初始化防止报错
        workout: {} // 初始化防止报错
      });
    }

    // 记录当时的模式快照
    const currentGoal = currentUser.fitnessGoal || 'maintain';
    if (fitnessRecord.diet) {
      fitnessRecord.diet.goalSnapshot = currentGoal;
    }

    // 生成日记文案
    // 格式： "晚餐选中了：【红烧肉】。"
    const newContent = `${mealTime || '大厨转盘'}选中了：【${finalDishName}】。`;
    const oldContent = fitnessRecord.diet.content || '';

    // 简单的去重/追加逻辑
    fitnessRecord.diet.content = oldContent ? `${oldContent}\n${newContent}` : newContent;

    // 自动补水逻辑 (通用)
    if (isSoup) {
      fitnessRecord.diet.water = (fitnessRecord.diet.water || 0) + 300;
      fitnessRecord.diet.content += ' (汤品自动补水 +300ml)';
    }

    await fitnessRecord.save();

    res.json({
      msg: `已确认【${finalDishName}】，并记录到您的饮食日记`,
      // 如果是 AI 菜，menu 字段返回 null 或构建一个临时对象，防止前端报错
      menu: menuItem || { name: finalDishName, _id: 'ai_generated' },
      fitness: fitnessRecord
    });
  } catch (err) {
    console.error('Confirm Dish Error:', err);
    res.status(500).send('Server Error');
  }
});

export default router;
