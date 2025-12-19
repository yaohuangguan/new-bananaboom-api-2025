const express = require("express");
const router = express.Router();
const { generateJSON } = require("../utils/aiProvider"); // 引入我们刚才封装好的工具
const auth = require("../middleware/auth"); // 依然建议加上鉴权，防止被路人刷爆


// 引入所有数据模型 (根据你实际的文件路径调整)
const User = require("../models/User");
const Fitness = require("../models/Fitness");
const Todo = require("../models/Todo");       
const Project = require("../models/Project"); 
const Post = require("../models/Post");       
const Resume = require("../models/Resume");   
// 建议加上 auth 中间件
router.use(auth); 

/**
 * =================================================================
 * 🤖 接口1：通用智能问答 (Q&A)
 * =================================================================
 * @route   POST /api/ai/ask
 * @desc    前端传什么就问什么，AI 返回 JSON 格式的答案
 * @body    { "prompt": "如何评价红楼梦？" }
 */
router.post("/ask", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) return res.status(400).json({ msg: "请提供问题内容" });

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
    res.status(500).json({ msg: "AI 思考超时，请重试" });
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
router.post("/recipe-recommend", async (req, res) => {
  const { dishName } = req.body;

  if (!dishName) return res.status(400).json({ msg: "请提供菜品名称" });

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
    res.status(500).json({ msg: "大厨正在忙，没顾上回复，请稍后再试" });
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
router.post("/ask-life", auth, async (req, res) => {
    const { prompt } = req.body;
    const userId = req.user.id;
  
    if (!prompt) return res.status(400).json({ msg: "请告诉我你想问什么" });
  
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
        Fitness.find({ user: userId }).sort({ date: -1 }).limit(50), // 最近50条健身
        Todo.find({ user: userId }).sort({ date: -1 }).limit(50),    // 最近50条待办
        Project.find({ user: userId }).select("title description techStack status"), // 所有项目
        Post.find({ user: userId }).sort({ date: -1 }).limit(20).select("title content tags"), // 最近20篇博客
        Resume.findOne({ user: userId }) // 简历通常只有一份
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
      res.status(500).json({ msg: "大脑过载了，请稍后再试" });
    }
  });
  
  module.exports = router;

module.exports = router;