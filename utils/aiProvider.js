// utils/aiProvider.js
import { GoogleGenAI } from '@google/genai';

// 1. 基础配置
if (!process.env.GEMINI_API_KEY) {
  throw new Error('❌ [Fatal] 缺少环境变量 GEMINI_API_KEY');
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// 生产级配置
const CONFIG = {
  PRIMARY_MODEL: 'gemini-3-flash-preview',
  FALLBACK_MODEL: 'gemini-2.0-flash-exp',
  MAX_RETRIES: 1,
  TIMEOUT_MS: 120000 // 2分钟超时
};

// ==========================================
// 1. 图片下载器
// ==========================================
const fetchImageAsBase64 = async (url) => {
  try {
    // 再次暴力去空
    const cleanUrl = url.trim().replace(/[\r\n]/g, '');
    
    // 设置 25秒 下载超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    // fetch 会自动走 server.js 里配置的全局代理
    const response = await fetch(cleanUrl, {
        headers: { 
            // 伪装成浏览器
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
        },
        signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (error) {
    console.error(`❌ [Download Fail] ${url.substring(0, 30)}... : ${error.message}`);
    return null; 
  }
};

// ==========================================
// 2. 数据清洗 (长度启发式绝杀版)
// ==========================================
const prepareContentForGemini = async (contents) => {
  if (!contents) return [];
  const items = Array.isArray(contents) ? contents : [contents];

  const processed = await Promise.all(items.map(async (msg, msgIdx) => {
    if (!msg.parts || !Array.isArray(msg.parts)) return msg;

    const newParts = await Promise.all(msg.parts.map(async (part, partIdx) => {
      let targetUrl = null;
      let mimeType = 'image/jpeg';
      let rawData = null;

      // 提取原始数据
      if (part.inline_data && typeof part.inline_data.data === 'string') {
        rawData = part.inline_data.data;
      } else if (typeof part.image === 'string') {
        rawData = part.image;
      }

      // 🕵️‍♀️ 【核心逻辑修改】
      // 不再迷信正则，而是使用“长度+特征”判断
      // 如果数据存在，且长度小于 2048 (Base64图片通常极大)，且包含 "http"
      // 那么它 1000% 是个 URL，不是 Base64
      if (rawData && rawData.length < 5000 && rawData.includes('http')) {
        targetUrl = rawData.trim();
        console.log(`🧹 [Cleaner] 捕获 URL (Msg:${msgIdx} Part:${partIdx}): ${targetUrl.substring(0, 40)}...`);
      }

      // 🛠️ 执行下载与替换
      if (targetUrl) {
        // 简单猜类型
        const lower = targetUrl.toLowerCase();
        if (lower.endsWith('.png')) mimeType = 'image/png';
        if (lower.endsWith('.webp')) mimeType = 'image/webp';
        if (lower.endsWith('.gif')) mimeType = 'image/gif';

        const base64 = await fetchImageAsBase64(targetUrl);
        
        if (base64) {
          // ✅ 成功转为 Base64
          return {
            inline_data: { mime_type: mimeType, data: base64 }
          };
        } else {
          // 🛑 下载失败：强制替换为文本
          console.warn(`⚠️ [Cleaner] 图片下载失败，已替换为文本占位符，防止 400 崩溃。`);
          return { text: `[图片无法加载: ${targetUrl.substring(0, 20)}...]` };
        }
      }

      // 🛡️ 【最后一道保险】
      // 如果上面的逻辑跑完，inline_data.data 依然是个短字符串且含 http，说明它是漏网之鱼
      // 我们直接销毁这个 part，绝不让它发给 Google
      if (part.inline_data?.data && 
          part.inline_data.data.length < 5000 && 
          part.inline_data.data.includes('http')) {
          
          console.error(`🛑 [Fatal] 拦截到顽固 URL，强制销毁！`);
          return { text: '[无效图片数据]' };
      }

      // 原样返回 (纯文本或正常的长 Base64)
      return part;
    }));

    return { ...msg, parts: newParts };
  }));

  return Array.isArray(contents) ? processed : processed[0];
};

// ==========================================
// 3. 辅助工具
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
// 4. 导出接口
// ==========================================

async function generateJSON(prompt, modelName = CONFIG.PRIMARY_MODEL) {
  let currentModel = modelName;
  let attempts = 0;
  const processedPrompt = await prepareContentForGemini(prompt);

  while (attempts <= CONFIG.MAX_RETRIES) {
    attempts++;
    console.log(`🤖 [AI JSON] Model: ${currentModel} (Attempt ${attempts})`);

    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: currentModel,
          contents: processedPrompt,
          config: { responseMimeType: 'application/json' }
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
      if (attempts <= CONFIG.MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      return { error: 'AI_BUSY', message: '服务繁忙' };
    }
  }
}

async function generateStream(promptInput) {
  const currentModel = CONFIG.PRIMARY_MODEL;
  let formattedContents = typeof promptInput === 'string' 
      ? [{ role: 'user', parts: [{ text: promptInput }] }] 
      : promptInput;
  formattedContents = await prepareContentForGemini(formattedContents);

  try {
    return await ai.models.generateContentStream({
      model: currentModel,
      contents: formattedContents
    });
  } catch (err) {
    try {
      return await ai.models.generateContentStream({
        model: CONFIG.FALLBACK_MODEL,
        contents: formattedContents
      });
    } catch (e) { throw err; }
  }
}

async function* createAgentStream(params) {
  const currentModel = CONFIG.PRIMARY_MODEL;
  
  // 🔥 清洗
  if (params.history) params.history = await prepareContentForGemini(params.history);
  params.prompt = await prepareContentForGemini(params.prompt);

  try {
    console.log(`🌊 [Agent Stream] Start: ${currentModel}`);
    yield* _runAgentLoop(currentModel, params);
  } catch (err) {
    console.warn(`⚠️ [Agent Warning] ${currentModel} failed: ${err.message}`);
    if (currentModel !== CONFIG.FALLBACK_MODEL) {
      console.log(`🔄 [Agent Fallback] Switching to ${CONFIG.FALLBACK_MODEL}`);
      try {
        yield* _runAgentLoop(CONFIG.FALLBACK_MODEL, params);
      } catch (fallbackErr) {
        throw new Error(`Agent failed: ${fallbackErr.message}`);
      }
    } else {
      throw err;
    }
  }
}

async function* _runAgentLoop(modelName, { systemInstruction, history, prompt, toolsSchema, functionsMap }) {
  let finalTools = undefined;
  if (toolsSchema) {
    finalTools = Array.isArray(toolsSchema) && toolsSchema[0]?.functionDeclarations 
        ? toolsSchema 
        : [{ functionDeclarations: toolsSchema }];
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
      console.log(`🤖 [Tool] ${funcName}`, args);
      let toolResult;
      if (functionsMap?.[funcName]) {
        try { toolResult = await functionsMap[funcName](args); } 
        catch (e) { toolResult = { error: e.message }; }
      } else { toolResult = { error: 'Function not found' }; }
      functionResponsesParts.push({
        functionResponse: { name: funcName, response: { content: toolResult } }
      });
    }
    const result2 = await chat.sendMessageStream({ message: functionResponsesParts });
    for await (const chunk2 of result2) {
      if (chunk2.text) yield chunk2.text;
    }
  }
}

async function generateTitle(historyText) {
  try {
    const prompt = `生成一个5-10字的纯文本标题: ${historyText.substring(0, 500)}`;
    const result = await ai.models.generateContent(prompt);
    return result.text ? result.text.trim() : '新对话';
  } catch (e) { return '新对话'; }
}

export { generateJSON, generateStream, createAgentStream, generateTitle };