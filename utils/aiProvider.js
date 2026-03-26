// utils/aiProvider.js
import { GoogleGenAI } from '@google/genai';
import { fetch } from 'undici'
import sharp from 'sharp';
// 1. 基础配置
if (!process.env.GEMINI_API_KEY) {
  throw new Error('❌ [Fatal] 缺少环境变量 GEMINI_API_KEY');
}

const clients = {
  default: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  'orion-english': process.env.GEMINI_ORION_ENGLISH_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_ORION_ENGLISH_API_KEY }) : null,
  reading: process.env.GEMINI_READING_APP_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_READING_APP_API_KEY }) : null,
};

const getAiClient = (appKey = 'default') => {
  return clients[appKey] || clients.default;
};

// 生产级配置
const CONFIG = {
  PRIMARY_MODEL: 'gemini-3-flash-preview',
  FALLBACK_MODEL: 'gemini-3-flash-preview',
  MAX_RETRIES: 1,
  TIMEOUT_MS: 120000 // 2分钟超时
};

// ==========================================
// 1. 强力下载器 (带详细 Debug)
// ==========================================
const fetchImageAsBase64 = async (url) => {
  const cleanUrl = url.trim();
  console.log(`📥 [Image] 尝试下载: ${cleanUrl.substring(0, 40)}...`);

  try {
    const response = await fetch(cleanUrl, {
      method: 'GET',
      redirect: 'follow', // 跟随重定向
      headers: {
        // Cloudflare WAF 通行证 (全小写)
        'x-server-secret': 'orion-x-888',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // 🔥 打印状态码，这是调试 Cloudflare 最关键的信息
    console.log(`📡 [Image Status] R2 返回: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errText = await response.text();
      // 如果是 403，说明 WAF 规则还是没配好；如果是 404，说明 URL 错了
      throw new Error(`下载失败 HTTP ${response.status} - ${errText.substring(0, 100)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);
    const originalSize = (buffer.length / 1024).toFixed(1);

    // 🔥 核心优化：如果图片超过 500KB，就进行压缩
    if (buffer.length > 500 * 1024) {
      // console.log(`📉 [Image] 图片过大 (${originalSize}KB), 正在压缩...`);
      try {
        buffer = await sharp(buffer)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }) // 限制最大尺寸
          .jpeg({ quality: 60, progressive: true }) // 转为 JPEG 60% 质量 (AI 足够看清)
          .toBuffer();
      } catch (e) {
        console.warn('⚠️ [Image] 压缩失败，将使用原图:', e.message);
      }
    }

    const finalSize = (buffer.length / 1024).toFixed(1);
    const base64 = buffer.toString('base64');
    
    console.log(`✅ [Image] 处理完毕: ${cleanUrl.substring(cleanUrl.length - 20)} | ${originalSize}KB -> ${finalSize}KB`);
    return base64;

  } catch (error) {
    console.error(`❌ [Image Error] ${error.message}`);
    return null; // 返回 null 触发后续的兜底逻辑
  }
};

// ==========================================
// 2. 核心：统一处理单个 Part 的逻辑 (提取出来了)
// ==========================================
const processSinglePart = async (part) => {
  if (!part) return part;

  // 1. 侦测 URL (兼容 image 字段和 inline_data 里的 url)
  let targetUrl = null;
  const inlineData = part.inlineData?.data
  const imageUrl = part.image; // 👈 专门捕获 routes/ai.js 传来的 { image: ... }

  if (typeof inlineData === 'string' && inlineData.startsWith('http')) targetUrl = inlineData;
  else if (typeof imageUrl === 'string' && imageUrl.startsWith('http')) targetUrl = imageUrl;

  // 2. 如果是 URL，下载并转换
  if (targetUrl) {
    let mimeType = 'image/jpeg';
    if (targetUrl.toLowerCase().includes('.png')) mimeType = 'image/png';
    if (targetUrl.toLowerCase().includes('.webp')) mimeType = 'image/webp';
    
    const base64Data = await fetchImageAsBase64(targetUrl);

    if (base64Data) {
      // ✅ 成功: 转为标准 Gemini 格式
      return { 
        inlineData: { 
          mimeType: mimeType, 
          data: base64Data 
        } 
      };
    } else {
      // 🛑 失败: 降级为文本，防止 400 错误
      return { text: `[系统提示: 图片下载失败]` };
    }
  }

  // 3. 如果本来就是正常的 Part (文本或已有Base64)，原样返回
  return part;
};

// ==========================================
// 3. 数据清洗 (升级版：支持 History 和 Prompt 两种结构)
// ==========================================
const prepareContentForGemini = async (contents) => {
  if (!contents) return [];
  // 深拷贝
  const rawItems = JSON.parse(JSON.stringify(Array.isArray(contents) ? contents : [contents]));

  const processed = await Promise.all(rawItems.map(async (item) => {
    // 🅰️ 情况 A: 这是一个完整的 Message 对象 (如 history)，包含 .parts 数组
    if (item.parts && Array.isArray(item.parts)) {
      const newParts = await Promise.all(item.parts.map(p => processSinglePart(p)));
      return { ...item, parts: newParts };
    }
    // 🅱️ 情况 B: 这是一个单独的 Part 对象 (如 prompt)，直接就是 { image: ... } 或 { text: ... }
    else {
      return await processSinglePart(item);
    }
  }));

  return Array.isArray(contents) ? processed : processed[0];
};

// ... 下面是常规函数，保持不变 ...

function cleanJSONString(text) {
  if (!text) return '{}';
  let clean = text.replace(/```json|```/g, '').trim();
  
  // 支持对象 {} 和数组 []
  const startIdx = clean.search(/[\[\{]/);
  const endBrace = clean.lastIndexOf('}');
  const endBracket = clean.lastIndexOf(']');
  const endIdx = Math.max(endBrace, endBracket);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    clean = clean.substring(startIdx, endIdx + 1);
  }
  return clean;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))]);
}

async function generateJSON(prompt, modelName = CONFIG.PRIMARY_MODEL, schema = null, appKey = 'default') {
  const ai = getAiClient(appKey);
  let currentModel = modelName;
  let attempts = 0;
  const processedPrompt = await prepareContentForGemini(prompt);

  while (attempts <= 1) {
    attempts++;
    console.log(`🤖 [AI JSON] Model: ${currentModel} (App: ${appKey})`);
    try {
      const config = { responseMimeType: 'application/json' };
      if (schema) config.responseSchema = schema;

      const response = await withTimeout(
        ai.models.generateContent({
          model: currentModel,
          contents: processedPrompt,
          config
        }),
        CONFIG.TIMEOUT_MS
      );
      const rawText = response.text || JSON.stringify(response);
      return JSON.parse(cleanJSONString(rawText));
    } catch (err) {
      console.error(`⚠️ [AI Error] ${currentModel}:`, err.message);
      if (err.message.includes('400')) throw err;
      if (currentModel !== CONFIG.FALLBACK_MODEL) {
        currentModel = CONFIG.FALLBACK_MODEL;
        attempts = 0;
        continue;
      }
      return { error: 'AI_BUSY', message: '服务繁忙' };
    }
  }
}

async function generateStream(promptInput, appKey = 'default') {
  const ai = getAiClient(appKey);
  const currentModel = CONFIG.PRIMARY_MODEL;
  let formattedContents = typeof promptInput === 'string' ? [{ role: 'user', parts: [{ text: promptInput }] }] : promptInput;
  formattedContents = await prepareContentForGemini(formattedContents);

  try {
    return await ai.models.generateContentStream({ model: currentModel, contents: formattedContents });
  } catch (err) {
    try {
      return await ai.models.generateContentStream({ model: CONFIG.FALLBACK_MODEL, contents: formattedContents });
    } catch (e) { throw err; }
  }
}

async function* createAgentStream(params, appKey = 'default') {
  const currentModel = CONFIG.PRIMARY_MODEL;
  
  if (params.history) params.history = await prepareContentForGemini(params.history);
  params.prompt = await prepareContentForGemini(params.prompt);

  try {
    console.log(`🌊 [Agent Stream] Start: ${currentModel} (App: ${appKey})`);
    yield* _runAgentLoop(currentModel, params, appKey);
  } catch (err) {
    console.warn(`⚠️ [Agent Warning] ${currentModel} failed: ${err.message}`);
    if (currentModel !== CONFIG.FALLBACK_MODEL) {
      console.log(`🔄 [Agent Fallback] Switching to ${CONFIG.FALLBACK_MODEL}`);
      try {
        yield* _runAgentLoop(CONFIG.FALLBACK_MODEL, params, appKey);
      } catch (fallbackErr) { throw new Error(`Agent failed: ${fallbackErr.message}`); }
    } else { throw err; }
  }
}

async function* _runAgentLoop(modelName, { systemInstruction, history, prompt, toolsSchema, functionsMap }, appKey = 'default') {
  const ai = getAiClient(appKey);
  let finalTools = undefined;
  if (toolsSchema) {
    finalTools = Array.isArray(toolsSchema) && toolsSchema[0]?.functionDeclarations 
        ? toolsSchema 
        : [{ functionDeclarations: toolsSchema }];
  }

  const chat = ai.chats.create({
    model: modelName,
    history: history || [],
    config: { systemInstruction, tools: finalTools }
  });

  const resultStream = await chat.sendMessageStream({ message: prompt });
  let functionCallFound = false;
  const functionCallsToExecute = [];

  for await (const chunk of resultStream) {
    const calls = chunk.functionCalls;
    if (calls && calls.length > 0) {
      functionCallFound = true;
      functionCallsToExecute.push(...calls);
      continue;
    }
    if (!functionCallFound && chunk.text) yield chunk.text;
  }

  if (functionCallFound && functionCallsToExecute.length > 0) {
    const functionResponsesParts = [];
    for (const call of functionCallsToExecute) {
      const funcName = call.name;
      const args = call.args;
      let toolResult;
      if (functionsMap?.[funcName]) {
        try { toolResult = await functionsMap[funcName](args); } 
        catch (e) { toolResult = { error: e.message }; }
      } else { toolResult = { error: 'Function not found' }; }
      functionResponsesParts.push({ functionResponse: { name: funcName, response: { content: toolResult } } });
    }
    const result2 = await chat.sendMessageStream({ message: functionResponsesParts });
    for await (const chunk2 of result2) { if (chunk2.text) yield chunk2.text; }
  }
}

async function generateTitle(historyText, appKey = 'default') {
  const ai = getAiClient(appKey);
  try {
    const prompt = `生成一个5-10字的纯文本标题: ${historyText.substring(0, 500)}`;
    const result = await ai.models.generateContent({ model: CONFIG.PRIMARY_MODEL, contents: prompt });
    return result.text ? result.text.trim() : '新对话';
  } catch (e) { return '新对话'; }
}

export { getAiClient, CONFIG, generateJSON, generateStream, createAgentStream, generateTitle };