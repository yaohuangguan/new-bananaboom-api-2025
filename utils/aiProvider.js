// utils/aiProvider.js
const { GoogleGenAI } = require("@google/genai");

// 1. 基础配置
if (!process.env.GEMINI_API_KEY) {
  throw new Error("❌ [Fatal] 缺少环境变量 GEMINI_API_KEY");
}

// 初始化客户端
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 生产级配置常量
const CONFIG = {
  // 首选模型 (你指定的)
  PRIMARY_MODEL: "gemini-3-flash-preview", 
  // 备胎模型 (如果首选挂了，自动切到这个最稳的)
  FALLBACK_MODEL: "gemini-2.0-flash-exp", 
  // 最大重试次数
  MAX_RETRIES: 2,
  // 超时时间 (毫秒)
  TIMEOUT_MS: 15000,
};

/**
 * 辅助函数：清洗 AI 返回的 JSON 字符串
 * 去除 ```json 代码块标记，处理可能的非标准字符
 */
function cleanJSONString(text) {
  if (!text) return "{}";
  // 1. 去除 Markdown 代码块标记 (```json ... ```)
  let clean = text.replace(/```json|```/g, "").trim();
  // 2. 尝试找到第一个 { 和最后一个 }，去除之外的废话
  const firstOpen = clean.indexOf("{");
  const lastClose = clean.lastIndexOf("}");
  if (firstOpen !== -1 && lastClose !== -1) {
    clean = clean.substring(firstOpen, lastClose + 1);
  }
  return clean;
}

/**
 * 辅助函数：带超时的 Promise 包装器
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms)
    ),
  ]);
}

/**
 * 核心生成函数 (支持重试、降级、清洗)
 * @param {string} prompt - 提示词
 * @param {string} modelName - 指定模型 (可选)
 */
async function generateJSON(prompt, modelName = CONFIG.PRIMARY_MODEL) {
  let currentModel = modelName;
  let attempts = 0;

  while (attempts <= CONFIG.MAX_RETRIES) {
    attempts++;
    console.log(`🤖 [AI] 正在请求模型: ${currentModel} (尝试 ${attempts}/${CONFIG.MAX_RETRIES + 1})`);

    try {
      // 1. 发起请求 (带超时控制)
      const response = await withTimeout(
        ai.models.generateContent({
          model: currentModel,
          contents: prompt,
          config: { responseMimeType: "application/json" },
        }),
        CONFIG.TIMEOUT_MS
      );

      // 2. 获取并清洗文本
      // 新版 SDK response.text 可能是 getter，直接访问
      const rawText = response.text || JSON.stringify(response);
      const cleanedText = cleanJSONString(rawText);

      // 3. 解析并返回
      return JSON.parse(cleanedText);

    } catch (err) {
      console.error(`⚠️ [AI Error] 模型 ${currentModel} 报错:`, err.message);

      // 🛑 情况 A: 致命错误 (404 Not Found / 400 Bad Request)
      // 说明模型名字不对，或者模型不存在。此时重试没用，直接降级！
      if (err.message.includes("404") || err.message.includes("not found") || err.message.includes("400")) {
        if (currentModel !== CONFIG.FALLBACK_MODEL) {
          console.warn(`🔄 [AI Fallback] 模型 ${currentModel} 不可用，自动切换到备用模型: ${CONFIG.FALLBACK_MODEL}`);
          currentModel = CONFIG.FALLBACK_MODEL;
          attempts = 0; // 重置重试次数给备用模型
          continue; // 立即用新模型重试
        } else {
           // 备胎也挂了，抛出错误
           throw new Error("所有模型均不可用，请检查 API Key 或网络");
        }
      }

      // 🛑 情况 B: 临时错误 (429 Too Many Requests / 503 Overloaded / Timeout)
      // 可以重试
      const isRetryable = err.message.includes("429") || err.message.includes("503") || err.message === "TIMEOUT";
      
      if (isRetryable && attempts <= CONFIG.MAX_RETRIES) {
        const delay = attempts * 1000; // 线性退避: 等待 1s, 2s...
        console.log(`⏳ [AI Retry] 遇到临时错误，${delay}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 无法修复的错误，或者重试次数用尽
      // 返回一个优雅的空对象或错误标识，避免前端白屏
      return { 
        error: "AI_GENERATION_FAILED", 
        message: "大厨正在忙，请稍后再试",
        debug: err.message 
      };
    }
  }
}

module.exports = { generateJSON };