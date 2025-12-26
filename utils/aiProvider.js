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
  // 首选模型
  PRIMARY_MODEL: 'gemini-3-flash-preview',
  // 备胎模型
  FALLBACK_MODEL: 'gemini-2.0-flash-exp',
  // 最大重试次数
  MAX_RETRIES: 2,
  // 超时时间 (毫秒)
  TIMEOUT_MS: 30000 
};

// ==========================================
// 核心修复区域：图片预处理逻辑
// ==========================================

// 辅助函数：简单的后缀名判断 MimeType (修复 fix)
const getMimeType = (urlOrBase64) => {
  if (!urlOrBase64) return 'image/jpeg';
  if (urlOrBase64.startsWith('http')) {
      const lower = urlOrBase64.toLowerCase();
      if (lower.endsWith('.png')) return 'image/png';
      if (lower.endsWith('.webp')) return 'image/webp';
      if (lower.endsWith('.gif')) return 'image/gif';
  }
  return 'image/jpeg';
};

// ==========================================
// 核心修复：简单的下载转码函数
// ==========================================
const fetchImageAsBase64 = async (url) => {
  try {
    // console.log(`⬇️ 下载图片转换: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败 ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch (e) {
    console.error(`❌ 图片转码失败: ${url}`, e.message);
    return null; // 失败返回 null
  }
};

// ==========================================
// 核心修复：暴力清洗数据 (History & Prompt)
// ==========================================
const prepareContentForGemini = async (contents) => {
  if (!contents) return [];
  // 统一转成数组处理
  const items = Array.isArray(contents) ? contents : [contents];

  // 深度遍历每一条消息
  const processed = await Promise.all(items.map(async (msg) => {
    // 如果没有 parts，直接返回
    if (!msg.parts) return msg;

    const newParts = await Promise.all(msg.parts.map(async (part) => {
      let targetUrl = null;
      let mimeType = 'image/jpeg';

      // 🛑 场景 1: 你的历史记录里可能直接存了 { inline_data: { data: 'https://...' } }
      // 这就是导致你报错的罪魁祸首！
      if (part.inline_data && part.inline_data.data && part.inline_data.data.startsWith('http')) {
        targetUrl = part.inline_data.data;
        // 简单猜一下类型
        if (targetUrl.endsWith('.png')) mimeType = 'image/png';
        if (targetUrl.endsWith('.webp')) mimeType = 'image/webp';
      }
      
      // 🛑 场景 2: 前端传来的 { image: 'https://...' } 自定义字段
      else if (part.image && part.image.startsWith('http')) {
        targetUrl = part.image;
        if (targetUrl.endsWith('.png')) mimeType = 'image/png';
        if (targetUrl.endsWith('.webp')) mimeType = 'image/webp';
      }

      // ✅ 如果发现是 URL，立即下载转 Base64
      if (targetUrl) {
        const base64 = await fetchImageAsBase64(targetUrl);
        if (base64) {
          return {
            inline_data: {
              mime_type: mimeType,
              data: base64 // 必须是长字符串，不能是 URL
            }
          };
        } else {
          // 下载失败，替换为文本，防止 API 崩溃
          return { text: '[图片无法加载]' };
        }
      }

      // 如果本来就是 Base64 或者纯文本，原样返回
      return part;
    }));

    return { ...msg, parts: newParts };
  }));

  return Array.isArray(contents) ? processed : processed[0];
};

// ==========================================
// 通用辅助函数
// ==========================================

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

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))]);
}

// ==========================================
// 导出接口
// ==========================================

/**
 * 核心生成函数 (支持重试、降级、清洗)
 */
async function generateJSON(prompt, modelName = CONFIG.PRIMARY_MODEL) {
  let currentModel = modelName;
  let attempts = 0;

  // 🔥 修复：预处理 prompt
  const processedPrompt = await prepareContentForGemini(prompt);

  while (attempts <= CONFIG.MAX_RETRIES) {
    attempts++;
    console.log(`🤖 [AI JSON] 请求模型: ${currentModel} (尝试 ${attempts}/${CONFIG.MAX_RETRIES + 1})`);

    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: currentModel,
          contents: processedPrompt, // 使用处理后的内容
          config: {
            responseMimeType: 'application/json'
          }
        }),
        CONFIG.TIMEOUT_MS
      );

      const rawText = response.text || JSON.stringify(response);
      const cleanedText = cleanJSONString(rawText);
      return JSON.parse(cleanedText);
    } catch (err) {
      console.error(`⚠️ [AI Error] 模型 ${currentModel} 报错:`, err.message);

      if (err.message.includes('404') || err.message.includes('not found') || err.message.includes('400')) {
        if (currentModel !== CONFIG.FALLBACK_MODEL) {
          console.warn(`🔄 [AI Fallback] 切换备用模型: ${CONFIG.FALLBACK_MODEL}`);
          currentModel = CONFIG.FALLBACK_MODEL;
          attempts = 0;
          continue;
        } else {
          // 400 错误通常是图片格式问题
          throw new Error(`AI 请求失败 (400/404). 请检查图片格式. ${err.message}`);
        }
      }

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
 */
async function generateStream(promptInput) {
  const currentModel = CONFIG.PRIMARY_MODEL;

  // 🔥 修复：预处理输入
  let formattedContents = typeof promptInput === 'string'
      ? [{ role: 'user', parts: [{ text: promptInput }] }]
      : promptInput;
      
  formattedContents = await prepareContentForGemini(formattedContents);

  try {
    console.log(`🌊 [AI Stream] Attempting model: ${currentModel}`);

    const responseStream = await ai.models.generateContentStream({
      model: currentModel,
      contents: formattedContents
    });

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
 */
async function* createAgentStream(params) {
  const currentModel = CONFIG.PRIMARY_MODEL;

  if (params.history) {
    params.history = await prepareContentForGemini(params.history);
  }
  params.prompt = await prepareContentForGemini(params.prompt);

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
  let finalTools = undefined;

  if (toolsSchema) {
    const isAlreadyWrapped =
      Array.isArray(toolsSchema) && toolsSchema.length > 0 && toolsSchema[0].functionDeclarations;

    if (isAlreadyWrapped) {
      finalTools = toolsSchema;
    } else if (Array.isArray(toolsSchema)) {
      finalTools = [
        {
          functionDeclarations: toolsSchema
        }
      ];
    }
  }

  const chat = ai.chats.create({
    model: modelName,
    history: history || [],
    config: {
      systemInstruction: systemInstruction,
      tools: finalTools,
      maxOutputTokens: 8192
    }
  });

  const resultStream = await chat.sendMessageStream({
    message: prompt
  });

  let functionCallFound = false;
  const functionCallsToExecute = [];

  for await (const chunk of resultStream) {
    const calls = chunk.functionCalls;

    if (calls && calls.length > 0) {
      functionCallFound = true;
      functionCallsToExecute.push(...calls);
      continue;
    }

    if (!functionCallFound) {
      const text = chunk.text;
      if (text) yield text;
    }
  }

  if (functionCallFound && functionCallsToExecute.length > 0) {
    const functionResponsesParts = [];

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

    console.log(`📤 [Agent Output] Sending ${functionResponsesParts.length} tool results back...`);

    const result2 = await chat.sendMessageStream({
      message: functionResponsesParts
    });

    for await (const chunk2 of result2) {
      const text2 = chunk2.text;
      if (text2) yield text2;
    }
  }
}

/**
 * ⚡️ 专门用于生成简短标题的工具函数
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

    // 修复：直接返回文本，因为 prompt 要求只返回文字，JSON.parse 容易报错
    return result.text ? result.text.trim() : '新对话';
  } catch (e) {
    console.error('标题生成失败:', e);
    return '新对话';
  }
}

export {
  generateJSON,
  generateStream,
  createAgentStream,
  generateTitle
};