// utils/aiProvider.js
import { GoogleGenAI } from '@google/genai';

// 1. 基础配置
if (!process.env.GEMINI_API_KEY) {
  throw new Error('❌ [Fatal] 缺少环境变量 GEMINI_API_KEY');
}

// 初始化客户端
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// 生产级配置常量
const CONFIG = {
  // 首选模型 (Gemini 3 Flash Preview, 适合快速响应)
  PRIMARY_MODEL: 'gemini-3-flash-preview',
  // 备胎模型 (Gemini 2.0 Flash Exp, 稳定性高)
  FALLBACK_MODEL: 'gemini-2.0-flash-exp',
  // 最大重试次数
  MAX_RETRIES: 2,
  // 超时时间 (毫秒)
  TIMEOUT_MS: 30000 // 稍微调大一点，Agent 执行可能较慢
};

/**
 * 辅助函数：清洗 AI 返回的 JSON 字符串
 */
function cleanJSONString(text) {
  if (!text) return '{}';
  let clean = text.replace(/```json|```/g, '').trim();
  const firstOpen = clean.indexOf('{');
  const lastClose = clean.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1) {
    clean = clean.substring(firstOpen, lastClose + 1);
  }
  return clean;
}

/**
 * 辅助函数：带超时的 Promise 包装器
 */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))]);
}

/**
 * 核心生成函数 (支持重试、降级、清洗)
 * 使用 ai.models.generateContent
 */
async function generateJSON(prompt, modelName = CONFIG.PRIMARY_MODEL) {
  let currentModel = modelName;
  let attempts = 0;

  while (attempts <= CONFIG.MAX_RETRIES) {
    attempts++;
    console.log(`🤖 [AI JSON] 请求模型: ${currentModel} (尝试 ${attempts}/${CONFIG.MAX_RETRIES + 1})`);

    try {
      // 1. 发起请求 (带超时控制)
      const response = await withTimeout(
        ai.models.generateContent({
          model: currentModel,
          contents: prompt,
          config: {
            responseMimeType: 'application/json'
          }
        }),
        CONFIG.TIMEOUT_MS
      );

      // 2. 获取并清洗文本
      // 新版 SDK 中 response.text 是一个 getter，直接访问即可
      const rawText = response.text || JSON.stringify(response);
      const cleanedText = cleanJSONString(rawText);

      // 3. 解析并返回
      return JSON.parse(cleanedText);
    } catch (err) {
      console.error(`⚠️ [AI Error] 模型 ${currentModel} 报错:`, err.message);

      // 🛑 致命错误处理
      if (err.message.includes('404') || err.message.includes('not found') || err.message.includes('400')) {
        if (currentModel !== CONFIG.FALLBACK_MODEL) {
          console.warn(`🔄 [AI Fallback] 切换备用模型: ${CONFIG.FALLBACK_MODEL}`);
          currentModel = CONFIG.FALLBACK_MODEL;
          attempts = 0;
          continue;
        } else {
          throw new Error('所有模型均不可用，请检查 API Key 或网络');
        }
      }

      // 🛑 临时错误重试
      const isRetryable = err.message.includes('429') || err.message.includes('503') || err.message === 'TIMEOUT';
      if (isRetryable && attempts <= CONFIG.MAX_RETRIES) {
        const delay = attempts * 1000;
        console.log(`⏳ [AI Retry] ${delay}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return {
        error: 'AI_GENERATION_FAILED',
        message: '大厨正在忙，请稍后再试',
        debug: err.message
      };
    }
  }
}

/**
 * 🌊 基础流式生成 (无 Agent)
 * 使用 ai.models.generateContentStream
 */
async function generateStream(promptInput) {
  let currentModel = CONFIG.PRIMARY_MODEL;

  // 格式化输入
  const formattedContents =
    typeof promptInput === 'string'
      ? [
          {
            role: 'user',
            parts: [
              {
                text: promptInput
              }
            ]
          }
        ]
      : promptInput;

  try {
    console.log(`🌊 [AI Stream] Attempting model: ${currentModel}`);

    const responseStream = await ai.models.generateContentStream({
      model: currentModel,
      contents: formattedContents
      // config: { maxOutputTokens: 8192 } // 可选
    });

    // 直接返回 stream 对象 (AsyncIterable)
    return responseStream;
  } catch (err) {
    console.error(`⚠️ [AI Stream Error] ${currentModel} failed:`, err.message);

    if (currentModel !== CONFIG.FALLBACK_MODEL) {
      console.warn(`🔄 [AI Stream Fallback] Switching to ${CONFIG.FALLBACK_MODEL}...`);
      try {
        const fallbackResponse = await ai.models.generateContentStream({
          model: CONFIG.FALLBACK_MODEL,
          contents: formattedContents
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
 * 🧠 Agent 流式生成器 (对外暴露)
 * 包含了自动降级逻辑
 */
async function* createAgentStream(params) {
  let currentModel = CONFIG.PRIMARY_MODEL;

  try {
    console.log(`🌊 [Agent Stream] Attempting with ${currentModel}...`);
    yield* _runAgentLoop(currentModel, params);
  } catch (err) {
    console.warn(`⚠️ [Agent Warning] ${currentModel} failed: ${err.message}`);

    if (currentModel !== CONFIG.FALLBACK_MODEL) {
      console.log(`🔄 [Agent Fallback] Switching to ${CONFIG.FALLBACK_MODEL}...`);
      try {
        yield* _runAgentLoop(CONFIG.FALLBACK_MODEL, params);
      } catch (fallbackErr) {
        console.error('❌ [Agent Error] All models failed.');
        throw new Error(`Agent failed on both models: ${fallbackErr.message}`);
      }
    } else {
      throw err;
    }
  }
}

/**
 * 🕵️ 内部核心逻辑：Agent 循环
 */
async function* _runAgentLoop(modelName, { systemInstruction, history, prompt, toolsSchema, functionsMap }) {
  // 🔥🔥🔥 核心修复：智能处理 tools 格式 (防止双重包装) 🔥🔥🔥
  let finalTools = undefined;

  if (toolsSchema) {
    // 检查 1: 是否已经是标准的 [{ functionDeclarations: [...] }] 格式
    const isAlreadyWrapped =
      Array.isArray(toolsSchema) && toolsSchema.length > 0 && toolsSchema[0].functionDeclarations;

    if (isAlreadyWrapped) {
      // 如果调用方已经包装好了，直接用
      finalTools = toolsSchema;
    } else if (Array.isArray(toolsSchema)) {
      // 如果只是纯函数定义的数组，我们帮它包装
      finalTools = [
        {
          functionDeclarations: toolsSchema
        }
      ];
    }
  }

  // 1. 创建 Chat 会话
  const chat = ai.chats.create({
    model: modelName,
    history: history || [],
    config: {
      systemInstruction: systemInstruction,
      tools: finalTools, // ✅ 使用处理过的 tools
      maxOutputTokens: 8192
    }
  });

  // 2. 发送用户 Prompt
  let resultStream = await chat.sendMessageStream({
    message: prompt
  });

  let functionCallFound = false;
  let functionCallsToExecute = [];

  // =================================================
  // 第一阶段：监听 AI 的初步反应
  // =================================================
  for await (const chunk of resultStream) {
    // A. 检查函数调用
    const calls = chunk.functionCalls;

    if (calls && calls.length > 0) {
      functionCallFound = true;
      functionCallsToExecute.push(...calls);
      continue;
    }

    // B. 普通文本
    if (!functionCallFound) {
      const text = chunk.text;
      if (text) yield text;
    }
  }

  // =================================================
  // 第二阶段：执行工具并获取最终回复 (Agent 核心)
  // =================================================
  if (functionCallFound && functionCallsToExecute.length > 0) {
    const functionResponsesParts = [];

    // 1. 执行所有被请求的函数
    for (const call of functionCallsToExecute) {
      const funcName = call.name;
      const args = call.args;

      console.log(`🤖 [Agent Executor] Calling: ${funcName}`, args);

      let toolResult;
      if (functionsMap && functionsMap[funcName]) {
        try {
          toolResult = await functionsMap[funcName](args);
        } catch (e) {
          console.error(`Tool execution error (${funcName}):`, e);
          toolResult = {
            error: `Execution failed: ${e.message}`
          };
        }
      } else {
        toolResult = {
          error: `Function ${funcName} not found on server`
        };
      }

      functionResponsesParts.push({
        functionResponse: {
          name: funcName,
          response: {
            content: toolResult
          }
        }
      });
    }

    // 2. 将执行结果发回给 AI
    console.log(`📤 [Agent Output] Sending ${functionResponsesParts.length} tool results back...`);

    const result2 = await chat.sendMessageStream({
      message: functionResponsesParts
    });

    // 3. 将 AI 读完执行结果后的最终回复，推给前端
    for await (const chunk2 of result2) {
      const text2 = chunk2.text;
      if (text2) yield text2;
    }
  }
}

/**
 * ⚡️ 专门用于生成简短标题的工具函数
 * 使用最便宜的 Flash 模型
 */
async function generateTitle(historyText) {
  try {
    const prompt = `
      基于以下对话，生成一个超简短的标题（5-15字）。
      规则：不要引号，不要标点，只要文字。
      
      对话内容：
      ${historyText.substring(0, 1000)}
    `;

    const result = await ai.models.generateContent(prompt);
    const rawText = result.text || JSON.stringify(result);
    const cleanedText = cleanJSONString(rawText);

    // 3. 解析并返回
    return JSON.parse(cleanedText);
  } catch (e) {
    console.error('标题生成失败:', e);
    return null;
  }
}

export {
  generateJSON,
  generateStream,
  createAgentStream,
  generateTitle
};
