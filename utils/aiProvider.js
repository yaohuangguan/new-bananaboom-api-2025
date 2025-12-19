// utils/aiProvider.js
// 1. 引入新版 SDK (注意：是 Client，不是 GoogleGenerativeAI)
const { Client } = require("@google/genai");

// 2. 检查环境变量
if (!process.env.GEMINI_API_KEY) {
  throw new Error("❌ 缺少环境变量 GEMINI_API_KEY");
}

// 3. 初始化客户端 (新版写法)
const client = new Client({ apiKey: process.env.GEMINI_API_KEY });

/**
 * 通用 AI 生成工具
 * @param {string} prompt - 提示词
 * @param {string} modelName - 模型名称 (默认使用你指定的 3-flash-preview)
 * @returns {Promise<Object>} - 返回解析后的 JSON
 */
async function generateJSON(prompt, modelName = "gemini-3-flash-preview") {
  try {
    console.log(`🤖 [AI Start] Model: ${modelName} (SDK: @google/genai)`);

    // 4. 新版 SDK 调用方式
    const response = await client.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    // 5. 获取返回文本 (新版 SDK 兼容处理)
    // 有时候 response.text 是函数，有时候是直接的文本，做个兼容
    let text = "";
    if (typeof response.text === "function") {
      text = response.text();
    } else if (response.text) {
      text = response.text;
    } else {
      // 兜底：如果结构不对，转字符串方便调试
      text = JSON.stringify(response);
    }

    // 6. 解析 JSON
    try {
      return JSON.parse(text);
    } catch (e) {
      console.warn("⚠️ [AI Warning] 非标准JSON，尝试修复");
      // 如果解析失败，返回 raw 字段，防止前端报错
      return { raw: text, error: "JSON_PARSE_FAILED" };
    }

  } catch (err) {
    console.error("❌ [AI Error]", err.message);
    
    // ⚠️ 友情提示：如果 gemini-3 报错 404，可能是 Google 还没全量开放
    // 到时候你可以把上面的默认值改成 'gemini-2.0-flash-exp'
    if (err.message.includes("404") || err.message.includes("not found")) {
      console.error("💡 提示: 如果模型不存在，请尝试将 modelName 改为 'gemini-2.0-flash-exp'");
    }
    
    throw err;
  }
}

module.exports = { generateJSON };