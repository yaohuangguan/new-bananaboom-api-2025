// utils/aiProvider.js
const { GoogleGenerativeAI } = require("@google/genai");

// 确保配置了 GEMINI_API_KEY
if (!process.env.GEMINI_API_KEY) {
  throw new Error("❌ 缺少环境变量 GEMINI_API_KEY");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * 通用 AI 生成工具 (默认使用最新的 Gemini 3 Flash Preview)
 * @param {string} prompt - 提示词
 * @param {string} modelName - 模型名称
 * @returns {Promise<Object>} - 返回解析后的 JSON
 */
async function generateJSON(prompt, modelName = "gemini-3-flash-preview") {
  try {
    // 🔥 自动使用最新的 Gemini 3 Flash Preview
    // 发布于 2025年12月17日，具备更强的逻辑推理能力 (Thinking Model) 且速度极快
    const model = genAI.getGenerativeModel({
      model: modelName,
      // 强制 JSON 输出
      generationConfig: { responseMimeType: "application/json" }
    });

    console.log(`🤖 [AI Start] Model: ${modelName}`);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    try {
      return JSON.parse(text);
    } catch (e) {
      console.warn("⚠️ [AI Warning] 非标准JSON，尝试修复");
      // 简单的容错返回
      return { raw: text, error: "JSON_PARSE_FAILED" };
    }

  } catch (err) {
    console.error("❌ [AI Error]", err.message);
    throw err;
  }
}

module.exports = { generateJSON };