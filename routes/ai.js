const express = require("express");
const router = express.Router();
const {
  generateJSON
} = require("../utils/aiProvider"); // 引入我们刚才封装好的工具
const auth = require("../middleware/auth"); // 依然建议加上鉴权，防止被路人刷爆
const checkPermission = require("../middleware/checkPermission");
const {
  toolsSchema,
  functions
} = require("../utils/aiTools");
const {
  createAgentStream
} = require("../utils/aiProvider");
const K = require('../config/constants');
const { PERIOD_COLORS } = require('../config/periodConstants')
// 引入所有数据模型 (根据你实际的文件路径调整)
const User = require("../models/User");
const Fitness = require("../models/Fitness");
const Todo = require("../models/Todo");
const Project = require("../models/Project");
const Post = require("../models/Post");
const Resume = require("../models/Resume");
const Period = require("../models/Period");
const systemCache = require("../cache/memoryCache");
// 建议加上 auth 中间件
router.use(auth);


// 引入 Day.js 处理时区
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * =================================================================
 * 🧠 第二大脑 (God Mode - 全量数据 + 1小时缓存 + 智能时区)
 * =================================================================
 * @route   POST /api/ai/ask-life/stream
 */
router.post("/ask-life/stream", auth, checkPermission(K.BRAIN_USE), async (req, res) => {
  const { prompt, history } = req.body;
  
  // 1. 获取当前用户对象
  const currentUser = req.user; 
  const userId = currentUser.id;

  if (!prompt) return res.status(400).json({ msg: "请说话" });

  // 设置流式响应头
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    // ==========================================
    // 2. 智能时间计算 (Day.js)
    // ==========================================
    const userTimezone = currentUser.timezone || "Asia/Shanghai";
    
    const nowObj = dayjs().tz(userTimezone);
    const userLocalTime = nowObj.format("YYYY-MM-DD HH:mm:ss");
    const userDate = nowObj.format("YYYY-MM-DD");
    const weekDayMap = ["日", "一", "二", "三", "四", "五", "六"];
    const currentWeekDay = weekDayMap[nowObj.day()];

    // ==========================================
    // 3. 准备全量数据 (优先查缓存)
    // ==========================================
    const cacheKey = `user_context_${userId}`;
    let contextData = systemCache.get(cacheKey);

    if (contextData) {
      console.log(`📦 [Cache Hit] 命中缓存 (User: ${currentUser.displayName})`);
    } else {
      console.log(`🐢 [Cache Miss] 正在全量加载第二大脑数据...`);
      
      // 并行查询所有数据
      const [userProfile, fitness, todos, projects, posts, resume, periods] = await Promise.all([
        User.findById(userId).select("-password -googleId -__v").lean(),
        Fitness.find({ user: userId }).sort({ date: -1 }).limit(30).select("-photos -__v -user").lean(),
        Todo.find({ user: userId }).sort({ date: -1 }).select("-__v -user").lean(),
       // 4. 🔥 项目经历 (全局数据，不查 user)
        // 既然是你个人的全量项目，直接查所有
        Project.find({}).select("-__v").lean(),
        Post.find({ user: userId }).sort({ date: -1 }).select("title tags date summary content").lean(),
        Resume.find({}).lean(),
        // 查最近 12 次记录，足够 AI 分析周期规律了
        Period.find({ user: userId }).sort({ startDate: -1 }).limit(12).select("-__v -user").lean()
      ]);

      // 截断过长的博客内容，防止 Token 爆炸
      const processedPosts = posts.map(p => ({
        ...p,
        content: p.content ? p.content.substring(0, 500) + "..." : ""
      }));

      contextData = {
        UserProfile: userProfile,
        FitnessRecords: fitness,
        Todos: todos,
        Projects: projects,
        Blogs: processedPosts,
        Resume: resume,
        PeriodRecords: periods
      };

      // 存入缓存，过期时间 1 小时 (3600秒)
      systemCache.set(cacheKey, contextData, 3600);
    }

    // ==========================================
    // 4. 构建系统提示词 (System Instruction)
    // ==========================================
    const systemInstruction = `
    你是一个拥有用户【全量第二大脑数据】的智能私人助理。
    当前用户时区: ${userTimezone}
    当前本地日期: ${userDate} (星期${currentWeekDay})

    【你的知识库】
    ${JSON.stringify(contextData)}

    【核心指令】
    1. 你拥有调用工具的能力 (记录体重、修改健身计划、添加待办等)。
    2. 当用户意图明确时，请**务必调用工具**，不要犹豫。
    3. 如果用户问关于自己的事 (如"我最近练得咋样")，请基于【知识库】回答。
    4. 如果用户问通用知识，忽略个人数据，正常回答。
    5. 回复风格：像个老朋友，幽默、专业、鼓励。

    【生理周期与健康分析】
    - 你拥有用户的生理周期记录 (PeriodRecords)。
    - 如果用户询问"我下次什么时候来"或"最近身体不适"，请基于历史数据计算平均周期并进行预测。
    - 在建议健身计划时，请智能结合生理期状态（例如：经期建议轻量运动，黄体期注意情绪波动）。
    生理周期数据说明】
    - PeriodRecords 中的 'color' 字段对应以下身体状态：
    ${Object.values(PERIOD_COLORS).map(c => `- ${c.code}: ${c.label} (${c.meaning})`).join('\n')}

  如果你发现用户最近的记录中出现了 PINK、ORANGE 或 BLACK，请在回答中给予适当的健康提醒，并建议咨询医生。

    【核心原则：主动确认与查重】
      1. **被动执行原则**：
        - 当用户提到一个计划（如“我想看电影”、“下周去旅行”）时，**不要**立即调用 add_todo 工具。
        - 你应该先回复用户：“听起来不错！需要我把这个行程加入待办清单吗？”
        - **只有**当用户明确回复“好的”、“存下来”、“记一下”时，才调用 add_todo。

      2. **严格查重原则**：
        - 在调用 add_todo 之前，**必须**检查当前的对话历史 (Conversation History)。
        - 如果用户只是在针对刚刚创建的任务提问（例如：“你怎么提醒我？”、“那个任务是几点？”），**绝对不要**重复创建任务。
        - 只有当内容是全新的，与上下文中的上一个任务无关时，才创建新任务。

      3. **智能上下文理解**：
        - 用户说“行，你怎么提醒我呢” -> 这是一个关于“提醒方式”的询问，**不是**让你再创建一个“阿凡达”任务。你应该解释提醒机制，而不是调用工具。
        
      【关于时间和提醒】
      1. **当前用户本地时间**：${userLocalTime}。
         - ⚠️ 极其重要：当用户说“5分钟后提醒我”或“明晚8点”时，你**必须**基于上述 [${userLocalTime}] 进行计算，得出准确的 ISO 时间戳。
      2. **通知能力**：你**拥有**向用户发送手机推送(Bark)和网页弹窗的能力。
        - **必须**计算出准确的 'remindAt' 时间戳传入 add_todo。
        - **不要**告诉用户你无法通知，直接告诉他们：“好的，会在 xx:xx 给您发送手机提醒”。

      【提醒策略】
      - 如果用户只是说“提醒我看电影”，默认设置提醒时间为电影开始前 **30分钟**。
      - 如果是重要行程（如旅行），可以额外创建一个“前一天晚上”的提醒任务。
      - 只要涉及“提醒”，**务必**填写 'remindAt' 字段，否则系统不会触发推送。
      
      当用户要求删除任务时，如果不知道ID，必须先调用 get_todos 查出 ID，然后再调用 delete_todo。
    `;

    // ==========================================
    // 5. 处理历史记录
    // ==========================================
    const geminiHistory = [];
    if (history && Array.isArray(history)) {
      history.slice(-10).forEach(h => {
        geminiHistory.push({
          role: h.role === 'ai' ? 'model' : 'user',
          parts: [{ text: h.content }]
        });
      });
    }

    // ==========================================
    // 6. 透传 User 对象给工具
    // ==========================================
    const boundFunctions = {};
    Object.keys(functions).forEach(funcName => {
      // 将当前用户对象注入到每个工具调用的 context 中
      boundFunctions[funcName] = (args) => functions[funcName](args, { user: currentUser });
    });

    // ==========================================
    // 7. 启动 Agent 流
    // ==========================================
    const stream = createAgentStream({
      systemInstruction,
      history: geminiHistory,
      prompt,
      toolsSchema,
      functionsMap: boundFunctions
    });

    for await (const chunkText of stream) {
      res.write(chunkText);
    }

    res.end();

  } catch (err) {
    console.error("AI Route Error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        msg: "大脑短路了",
        error: err.message
      });
    } else {
      res.write("\n\n[System Error: 连接中断]");
      res.end();
    }
  }
});

/**
 * =================================================================
 * 🤖 接口1：通用智能问答 (Q&A)
 * =================================================================
 * @route   POST /api/ai/ask
 * @desc    前端传什么就问什么，AI 返回 JSON 格式的答案
 * @body    { "prompt": "如何评价红楼梦？" }
 */
router.post("/ask", auth, checkPermission(K.BRAIN_USE), async (req, res) => {
  const {
    prompt
  } = req.body;

  if (!prompt) return res.status(400).json({
    msg: "请提供问题内容"
  });

  // 构造 Prompt：强制要求 JSON，防止 AI 废话
  const systemPrompt = `
    你是一位知识渊博的智能助手。请回答用户的问题。
    用户问题：${prompt}
    
    请务必严格按照以下 JSON 格式返回，不要包含 markdown 格式化符号：
    {
      "answer": "这里是你的回答内容，可以使用换行符\\n进行排版"
    }
  `;

  try {
    const data = await generateJSON(systemPrompt);
    res.json(data); // 返回 { answer: "..." }
  } catch (err) {
    res.status(500).json({
      msg: "AI 思考超时，请重试"
    });
  }
});

/**
 * =================================================================
 * 🍳 接口2：菜品做法 + 搭配推荐 (Recipe & Pairing)
 * =================================================================
 * @route   POST /api/ai/recipe-recommend
 * @desc    前端传菜名，AI 返回：详细做法 + 3道推荐配菜
 * @body    { "dishName": "红烧肉" }
 */
router.post("/recipe-recommend", auth, async (req, res) => {
  const {
    dishName
  } = req.body;

  if (!dishName) return res.status(400).json({
    msg: "请提供菜品名称"
  });

  // 构造 Prompt：核心是让 AI 既给做法，又给配菜
  const systemPrompt = `
    你是一位米其林星级主厨。用户想做"${dishName}"。
    请完成以下两项任务：
    1. 提供"${dishName}"的详细专业做法（食材、步骤、小贴士）。
    2. 推荐 3 道适合与"${dishName}"搭配吃的配菜（例如荤素搭配、解腻、汤品等），并说明理由。

    请务必严格按照以下 JSON 格式返回：
    {
      "recipe": {
        "title": "${dishName}",
        "description": "一句话诱人的介绍",
        "difficulty": "难度(如：简单/中等/困难)",
        "time": "预计耗时(如：40分钟)",
        "ingredients": ["五花肉 500g", "冰糖 20g", "生抽 2勺"...],
        "steps": [
          "第一步的具体操作...",
          "第二步的具体操作..."
        ],
        "tips": "大厨的小贴士..."
      },
      "side_dishes": [
        {
          "name": "推荐配菜名1",
          "reason": "为什么要配这道菜(如：解腻、口感互补)"
        },
        {
          "name": "推荐配菜名2",
          "reason": "推荐理由"
        },
        {
          "name": "推荐配菜名3",
          "reason": "推荐理由"
        }
      ]
    }
  `;

  try {
    const data = await generateJSON(systemPrompt);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      msg: "大厨正在忙，没顾上回复，请稍后再试"
    });
  }
});

/**
 * =================================================================
 * 🧠 接口3：第二大脑 (Second Brain) - 基于全量数据的问答
 * =================================================================
 * @route   POST /api/ai/ask-life
 * @desc    读取用户 Fitness, Todo, Project, Post, Resume 所有数据进行回答
 * @body    { "prompt": "我最近健身效果咋样？顺便看看我项目进度和待办还剩多少？" }
 */
router.post("/ask-life", auth, checkPermission(K.BRAIN_USE), async (req, res) => {
  const {
    prompt
  } = req.body;
  const userId = req.user.id;

  if (!prompt) return res.status(400).json({
    msg: "请告诉我你想问什么"
  });

  try {
    console.log("🧠 [Second Brain] 开始加载用户全量数据...");

    // 1. 并行查询所有数据 (使用 Promise.all 极速加载)
    // 注意：这里做了 limit 限制防止 Token 溢出，Gemini 虽然大，但最好还是防一下
    // 如果数据量巨大，可以只取最近半年的，或者关键字段
    const [
      userProfile,
      fitnessRecords,
      todos,
      projects,
      posts,
      resume
    ] = await Promise.all([
      User.findById(userId).select("-password -googleId"),
      Fitness.find({
        user: userId
      }).sort({
        date: -1
      }).limit(50), // 最近50条健身
      Todo.find({
        user: userId
      }).sort({
        date: -1
      }).limit(50), // 最近50条待办
      Project.find({
        user: userId
      }).select("title description techStack status"), // 所有项目
      Post.find({
        user: userId
      }).sort({
        date: -1
      }).limit(20).select("title content tags"), // 最近20篇博客
      Resume.findOne({
        user: userId
      }) // 简历通常只有一份
    ]);

    // 2. 数据清洗与序列化 (将对象转为精简的文本描述)
    // 我们把数据转成 JSON 字符串，AI 能读懂结构化数据
    const knowledgeBase = {
      UserProfile: {
        name: userProfile.displayName,
        goal: userProfile.fitnessGoal,
        height: userProfile.height
      },
      FitnessHistory: fitnessRecords.map(r => ({
        date: r.dateStr,
        weight: r.body.weight,
        workout: r.workout.types.join(","),
        duration: r.workout.duration,
        diet_mode: r.diet.goalSnapshot
      })),
      PendingTodos: todos.map(t => ({
        task: t.title,
        status: t.isCompleted ? "Done" : "Pending",
        deadline: t.dateStr
      })),
      Projects: projects.map(p => ({
        name: p.title,
        desc: p.description,
        tech: p.techStack,
        status: p.status
      })),
      RecentThoughts: posts.map(p => ({
        date: p.date,
        title: p.title,
        summary: p.content ? p.content.substring(0, 100) + "..." : "" // 截取前100字节省token
      })),
      ResumeHighlights: resume ? {
        skills: resume.skills,
        experience: resume.experience
      } : "暂无简历"
    };

    // 3. 构造超级 Prompt
    const systemPrompt = `
        你就是用户的“第二大脑” (Second Brain)。你拥有用户所有的数字生活数据。
        
        【用户当前问题】：
        "${prompt}"
  
        【你的知识库 (用户的真实数据)】：
        ${JSON.stringify(knowledgeBase, null, 2)}
  
        【回答要求】：
        1. 请综合分析【知识库】中的数据来回答问题。如果数据里没有相关信息，请实话实说。
        2. 你的回答必须有理有据。例如，如果用户问“我最近状态咋样”，你要结合健身记录(体重变化)、待办事项(完成度)和博客(心情)来综合评判。
        3. 语气要像一个贴心的私人管家，既专业又熟悉用户的情况。
        4. 请务必严格按照以下 JSON 格式返回：
        {
          "answer": "这里是你的回答内容，支持 Markdown 格式",
          "referenced_modules": ["Fitness", "Todo"] // 你在回答中引用了哪些模块的数据
        }
      `;

    // 4. 调用 AI (gemini-3-flash-preview 这里的长窗口优势就出来了)
    const data = await generateJSON(systemPrompt);

    res.json({
      success: true,
      data: data
    });

  } catch (err) {
    console.error("Second Brain Error:", err);
    res.status(500).json({
      msg: "大脑过载了，请稍后再试"
    });
  }
});



module.exports = router;