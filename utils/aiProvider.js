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


/**
 * 辅助函数：清洗 Prompt 格式
 * 确保发给 SDK 的永远是标准数组结构，防止报错
 */
function formatInput(input) {
  // 如果已经是数组（比如你以后做原生 Chat），直接返回
  if (Array.isArray(input)) return input;
  
  // 如果是字符串（God Mode 拼凑的大文本），包装成 User Message
  return [
    {
      role: "user",
      parts: [{ text: String(input) }] // 强制转 string 防止传进来 undefined
    }
  ];
}

/**
 * 🌊 流式生成工具 (Final Version)
 * @param {string | Array} promptInput - 提示词或对话数组
 * @returns {Promise<AsyncGenerator>} - 返回可迭代的流对象
 */
async function generateStream(promptInput) {
  let currentModel = CONFIG.PRIMARY_MODEL;

  // 格式化输入：虽然文档说支持 string，但包装成对象最稳妥
  const formattedContents = typeof promptInput === 'string'
    ? { role: 'user', parts: [{ text: promptInput }] }
    : promptInput; // 如果已经是数组直接用

  try {
    console.log(`🌊 [AI Stream] Attempting model: ${currentModel}`);

    // 🔥 调用新版 SDK
    // 注意：generateContentStream 返回的 response 本身就是 async iterable
    const response = await ai.models.generateContentStream({
      model: currentModel,
      contents: formattedContents,
      config: {
        // 可选配置
        // maxOutputTokens: 8192,
      }
    });

    // 这里直接返回 response 对象即可，因为它实现了 [Symbol.asyncIterator]
    return response;

  } catch (err) {
    console.error(`⚠️ [AI Stream Error] ${currentModel} failed:`, err.message);

    // --- 自动降级逻辑 ---
    if (currentModel !== CONFIG.FALLBACK_MODEL) {
      console.warn(`🔄 [AI Stream Fallback] Switching to ${CONFIG.FALLBACK_MODEL}...`);
      try {
        const fallbackResponse = await ai.models.generateContentStream({
          model: CONFIG.FALLBACK_MODEL,
          contents: formattedContents,
        });
        return fallbackResponse;
      } catch (fallbackErr) {
        throw new Error(`AI Stream All Failed: ${fallbackErr.message}`);
      }
    }
    throw err;
  }
}

/**
 * 🧠 对外暴露的 Agent 流式生成器
 * 包含了自动降级逻辑：如果 3.0 挂了，自动切 2.0
 */
async function* createAgentStream(params) {
  let currentModel = CONFIG.PRIMARY_MODEL;

  try {
    console.log(`🌊 [Agent Stream] Attempting with ${currentModel}...`);
    // 尝试使用主模型运行
    yield* _runAgentLoop(currentModel, params);

  } catch (err) {
    console.warn(`⚠️ [Agent Warning] ${currentModel} failed: ${err.message}`);
    
    // 如果主模型失败，且备胎模型不一样，则切换
    if (currentModel !== CONFIG.FALLBACK_MODEL) {
      console.log(`🔄 [Agent Fallback] Switching to ${CONFIG.FALLBACK_MODEL}...`);
      try {
        // 尝试使用备胎模型运行
        yield* _runAgentLoop(CONFIG.FALLBACK_MODEL, params);
      } catch (fallbackErr) {
        console.error("❌ [Agent Error] All models failed.");
        throw new Error(`Agent failed on both models: ${fallbackErr.message}`);
      }
    } else {
      throw err;
    }
  }
}

/**
 * 🕵️ 内部核心逻辑：Agent 循环
 * 负责：对话 -> 监听流 -> 拦截工具调用 -> 执行工具 -> 二次生成
 */
async function* _runAgentLoop(modelName, { systemInstruction, history, prompt, toolsSchema, functionsMap }) {
  
  // 1. 初始化模型实例
  const model = ai.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction,
    tools: toolsSchema, // 注入工具定义
    config: {
       // 防止死循环或生成过长
       maxOutputTokens: 8192, 
    }
  });

  // 2. 启动对话会话
  const chat = model.startChat({ history });

  // 3. 发送用户 prompt (开启第一段流)
  const result = await chat.sendMessageStream([{ role: 'user', parts: [{ text: prompt }] }]);

  // 临时状态
  let functionCallFound = false;
  let functionCallsToExecute = [];

  // =================================================
  // 第一阶段：监听 AI 的初步反应
  // =================================================
  for await (const chunk of result.stream) {
    // A. 检查 SDK 是否解析出了函数调用
    const calls = chunk.functionCalls();
    
    if (calls && calls.length > 0) {
      functionCallFound = true;
      functionCallsToExecute.push(...calls);
      // 注意：当发现函数调用时，我们不 yield 文本，因为此时通常没有文本，或者文本是中断的
      continue; 
    }

    // B. 如果没有函数调用，说明是普通聊天，直接吐字
    if (!functionCallFound) {
      const text = chunk.text();
      if (text) yield text;
    }
  }

  // =================================================
  // 第二阶段：执行工具并获取最终回复 (Agent 核心)
  // =================================================
  if (functionCallFound && functionCallsToExecute.length > 0) {
    
    const functionResponses = [];

    // 1. 执行所有被请求的函数
    for (const call of functionCallsToExecute) {
      const funcName = call.name;
      const args = call.args;
      
      console.log(`🤖 [Agent Executor] Model: ${modelName} | Calling: ${funcName}`, args);

      let toolResult;
      // 在传入的映射表中查找函数
      if (functionsMap && functionsMap[funcName]) {
        try {
          // 🔥 执行真实逻辑 (这里的函数已经绑定了 userId)
          toolResult = await functionsMap[funcName](args);
        } catch (e) {
          console.error(`Tool execution error (${funcName}):`, e);
          toolResult = { error: `Execution failed: ${e.message}` };
        }
      } else {
        toolResult = { error: `Function ${funcName} not found on server` };
      }

      // 构造 Gemini 需要的 FunctionResponse 格式
      functionResponses.push({
        functionResponse: {
          name: funcName,
          response: { content: toolResult } // 必须包在 content 里
        }
      });
    }

    // 2. 将执行结果发回给 AI (开启第二段流)
    console.log(`📤 [Agent Output] Sending ${functionResponses.length} tool results back to AI...`);
    
    const result2 = await chat.sendMessageStream([{ role: 'function', parts: functionResponses }]);

    // 3. 将 AI 读完执行结果后的最终回复，推给前端
    for await (const chunk2 of result2.stream) {
      const text2 = chunk2.text();
      if (text2) yield text2;
    }
  }
}

module.exports = { generateJSON, generateStream, createAgentStream };