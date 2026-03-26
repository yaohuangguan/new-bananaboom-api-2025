import { Router } from 'express';
import { Type } from '@google/genai';
import { generateJSON, getAiClient, CONFIG } from '../utils/aiProvider.js';

const router = Router();
// 默认使用的模型，如果要在 fallback 和 primary 之间切换，可以直接使用 CONFIG.PRIMARY_MODEL 或 CONFIG.FALLBACK_MODEL
// 这里遵照前端传入的 "gemini-2.5-flash" 模型，但为了兼容性，也可以用我们自己的 primary model
const modelFlash = 'gemini-2.5-flash';

const getLangInstruction = (lang) => 
  lang === 'zh' 
    ? "IMPORTANT: Generate all display text (titles, descriptions, questions, answers, content) in Simplified Chinese (zh-CN). Keep JSON property keys in English." 
    : "IMPORTANT: Generate all content in English.";

/**
 * =================================================================
 * 1. 生成学习计划 (Chapters)
 * =================================================================
 */
router.post('/learning-plan', async (req, res) => {
  const { bookTitle, content = "", preferences, language = 'zh' } = req.body;
  if (!bookTitle || !preferences) return res.status(400).json({ msg: "Missing required fields" });

  const prompt = `
    Create a personalized gamified learning path for the book "${bookTitle}".
    ${getLangInstruction(language)}
    
    User Preferences:
    - Goal: ${preferences.goal}
    - Interests: ${preferences.interests?.join(", ")}
    - Prior Knowledge: ${preferences.priorKnowledge}

    Break the book down into 6-10 distinct levels or "Chapters" to ensure deep coverage.
    If the goal is "Exam Prep", emphasize key facts and summaries.
    If the goal is "Casual Reading", emphasize plot and roleplay.
    
    For each chapter, suggest 2-3 suitable activity types (QUIZ, FLASHCARDS, ROLEPLAY) that best fit the content and user preferences.
    
    File Content Snippet (first 1500 chars): ${content.substring(0, 1500)}...
  `;

  const schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.INTEGER },
        title: { type: Type.STRING },
        description: { type: Type.STRING },
        activities: {
          type: Type.ARRAY,
          items: { type: Type.STRING, enum: ["QUIZ", "FLASHCARDS", "ROLEPLAY"] }
        }
      },
      required: ["id", "title", "description", "activities"]
    }
  };

  try {
    const chapters = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema, 'reading');
    
    const transformed = (Array.isArray(chapters) ? chapters : []).map((c, index) => ({
      ...c,
      id: index + 1, // Ensure sequential IDs
      isLocked: index !== 0,
      isCompleted: false
    }));

    res.json({ success: true, data: transformed });
  } catch (error) {
    console.error("Error generating learning plan:", error);
    res.status(500).json({ success: false, msg: "Failed to generate learning plan", error: error.message });
  }
});

/**
 * =================================================================
 * 1.5 生成学习指南 (主题、角色、摘要)
 * =================================================================
 */
router.post('/study-guide', async (req, res) => {
  const { bookTitle, content = "", language = 'zh' } = req.body;
  if (!bookTitle) return res.status(400).json({ msg: "Missing bookTitle" });

  const prompt = `
    Create a comprehensive, deep-dive study guide for the book "${bookTitle}".
    ${getLangInstruction(language)}
    
    Provide:
    1. A Global Summary: A detailed overview of the entire book (approx 400-600 words). Use Markdown for formatting.
    2. A list of 5-8 Key Characters with detailed analysis of their roles and evolution.
    3. A list of 5-8 Key Themes with deep analysis.
    
    File Content Snippet: ${content.substring(0, 1000)}...
  `;

  const schema = {
    type: Type.OBJECT,
    properties: {
      globalSummary: { type: Type.STRING },
      characters: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            role: { type: Type.STRING },
            description: { type: Type.STRING }
          },
          required: ["name", "role", "description"]
        }
      },
      themes: {
         type: Type.ARRAY,
         items: {
            type: Type.OBJECT,
            properties: {
               name: { type: Type.STRING },
               description: { type: Type.STRING }
            },
            required: ["name", "description"]
         }
      }
    },
    required: ["globalSummary", "characters", "themes"]
  };

  try {
    const data = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema, 'reading');
    res.json({ success: true, data: data });
  } catch (error) {
    console.error("Error generating study guide:", error);
    res.status(500).json({ success: false, msg: "Failed to generate study guide", error: error.message });
  }
});

/**
 * =================================================================
 * 1.8 生成章节导读 (Lead-in Reading)
 * =================================================================
 */
router.post('/chapter-guide', async (req, res) => {
  const { bookTitle, chapterTitle, preferences, language = 'zh' } = req.body;
  if (!bookTitle || !chapterTitle || !preferences) return res.status(400).json({ msg: "Missing required fields" });

  const prompt = `
    You are an expert literature professor teaching a master class. The student is studying "${chapterTitle}" from "${bookTitle}".
    User Goal: ${preferences.goal}.
    User Interests: ${preferences.interests?.join(", ")}.
    ${getLangInstruction(language)}
    
    Create an extensive "Guided Reading" module for this chapter.
    
    1. 'content': This is the main reading section. It must be VERY DETAILED (approx 800-1200 words). 
       - Do NOT just summarize. Retell the narrative in an engaging way.
       - Analyze user interests (e.g., if they like Symbolism, discuss symbols in this chapter).
       - Use Markdown heavily: Headers (##), Bold (**text**), Blockquotes (>), and Lists.
       - Make it immersive. The user should feel like they read the chapter.
    
    2. 'keyPoints': A list of 5-7 crucial takeaways or analysis points.

    Output pure JSON.
  `;

  const schema = {
    type: Type.OBJECT,
    properties: {
      chapterTitle: { type: Type.STRING },
      content: { type: Type.STRING },
      keyPoints: {
        type: Type.ARRAY,
        items: { type: Type.STRING }
      }
    },
    required: ["chapterTitle", "content", "keyPoints"]
  };

  try {
    const data = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema, 'reading');
    res.json({ success: true, data: data });
  } catch (error) {
    console.error("Error generating chapter guide:", error);
    res.status(500).json({ success: false, msg: "Failed to generate chapter guide", error: error.message });
  }
});

/**
 * =================================================================
 * 2. 生成测验 (Quiz)
 * =================================================================
 */
router.post('/quiz', async (req, res) => {
  const { bookTitle, chapterTitle, language = 'zh' } = req.body;
  if (!bookTitle || !chapterTitle) return res.status(400).json({ msg: "Missing required fields" });

  const prompt = `Generate 5 challenging multiple-choice questions for the chapter "${chapterTitle}" of the book "${bookTitle}". Questions should test deep understanding, not just surface facts. ${getLangInstruction(language)}`;

  const schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING },
        options: { type: Type.ARRAY, items: { type: Type.STRING } },
        correctAnswerIndex: { type: Type.INTEGER },
        explanation: { type: Type.STRING }
      },
      required: ["question", "options", "correctAnswerIndex", "explanation"]
    }
  };

  try {
    const data = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema, 'reading');
    res.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (error) {
    console.error("Error generating quiz:", error);
    res.status(500).json({ success: false, msg: "Failed to generate quiz", error: error.message });
  }
});

/**
 * =================================================================
 * 3. 生成闪卡 (Flashcards)
 * =================================================================
 */
router.post('/flashcards', async (req, res) => {
  const { bookTitle, chapterTitle, language = 'zh' } = req.body;
  if (!bookTitle || !chapterTitle) return res.status(400).json({ msg: "Missing required fields" });

  const prompt = `Create 8 flashcards for "${chapterTitle}" of "${bookTitle}". Include complex concepts, key quotes, or character motivations. ${getLangInstruction(language)}`;

  const schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        front: { type: Type.STRING },
        back: { type: Type.STRING }
      },
      required: ["front", "back"]
    }
  };

  try {
    const data = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema, 'reading');
    res.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (error) {
    console.error("Error generating flashcards:", error);
    res.status(500).json({ success: false, msg: "Failed to generate flashcards", error: error.message });
  }
});

/**
 * =================================================================
 * 4. 角色扮演聊天 (Chat with Character)
 * =================================================================
 */
router.post('/chat', async (req, res) => {
  const { bookTitle, chapterTitle, language = 'zh', history = [], message } = req.body;
  if (!bookTitle || !chapterTitle || !message) return res.status(400).json({ msg: "Missing required fields" });

  const langText = language === 'zh' ? "Speak in Simplified Chinese." : "Speak in English.";
  const systemInstruction = `You are an immersive roleplay character from the book "${bookTitle}", specifically relevant to the chapter "${chapterTitle}". 
  First, introduce yourself briefly and set the scene. Then engage the user in a deep discussion about the events. 
  Encourage the user to think critically.
  ${langText}
  Do not break character.`;

  try {
    const readingAi = getAiClient('reading');
    const model = readingAi.getGenerativeModel({ 
      model: CONFIG.PRIMARY_MODEL,
      systemInstruction: systemInstruction 
    });

    const chat = model.startChat({
      history: history
    });
    
    const result = await chat.sendMessage(message);
    res.json({ success: true, text: result.response.text() });
  } catch (error) {
    console.error("Error in chatWithCharacter:", error);
    res.status(500).json({ success: false, msg: "Chat failed", error: error.message });
  }
});

/**
 * =================================================================
 * 5. 生成简单摘要 (Summary fallback)
 * =================================================================
 */
router.post('/summary', async (req, res) => {
  const { bookTitle, chapterTitle, language = 'zh' } = req.body;
  if (!bookTitle || !chapterTitle) return res.status(400).json({ msg: "Missing required fields" });

  const prompt = `Provide a concise, engaging summary of "${chapterTitle}" from "${bookTitle}". Use emojis. Focus on the emotional journey or key logic. ${getLangInstruction(language)}`;
  
  try {
    const readingAi = getAiClient('reading');
    const model = readingAi.getGenerativeModel({ model: CONFIG.PRIMARY_MODEL });
    const response = await model.generateContent(prompt);
    res.json({ success: true, text: response.response.text() || "Could not generate summary." });
  } catch (error) {
    console.error("Error generating summary:", error);
    res.status(500).json({ success: false, msg: "Failed to generate summary", error: error.message });
  }
});

export default router;
