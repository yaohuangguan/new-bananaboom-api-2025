const express = require("express");
const router = express.Router();
const { generateJSON } = require("../utils/aiProvider"); // 引入我们刚才封装好的工具
const auth = require("../middleware/auth"); // 依然建议加上鉴权，防止被路人刷爆

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

module.exports = router;