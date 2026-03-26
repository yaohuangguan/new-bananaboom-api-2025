import { Router } from 'express';
import { Type, Modality } from '@google/genai';
import { getAiClient, CONFIG, generateJSON } from '../utils/aiProvider.js';

const router = Router();

// --- 助手函数 (从前端移植) ---

const SYSTEM_INSTRUCTION_GENERATOR = `
You are an expert debate organizer and profiler. Your goal is to create two distinct, diametrically opposed personas based on a user-provided topic.
These personas should have conflicting worldviews, different speaking styles, specific backgrounds, hidden biases, and distinct voices (metaphorically).
One should be Pro (or side A) and one Con (or side B).
`;

const getDebaterInstruction = (config) => {
  let toneInstruction = "";
  switch (config.tone) {
    case 'humorous':
      toneInstruction = "Be funny, sarcastic, and use witty analogies. It's okay to be slightly absurd.";
      break;
    case 'aggressive':
      toneInstruction = "Be intense, provocative, and attack the opponent's logic mercilessly. Use strong language.";
      break;
    case 'academic':
      toneInstruction = "Use formal language, cite theoretical frameworks, and focus on empirical evidence and logic. Be polite but rigorous.";
      break;
    case 'serious':
    default:
      toneInstruction = "Keep it professional, logical, and persuasive.";
      break;
  }

  let lengthInstruction = "";
  switch (config.length) {
    case 'short':
      lengthInstruction = "Keep your response extremely brief (under 30 words). Get straight to the point.";
      break;
    case 'long':
      lengthInstruction = "You can elaborate on your points (up to 120 words). Provide detailed examples.";
      break;
    case 'medium':
    default:
      lengthInstruction = "Keep your response concise (under 80 words).";
      break;
  }

  return `
You are a participant in a heated debate. 
You must stay strictly in character. 
${toneInstruction}
${lengthInstruction}
Do not be overly polite; this is a clash of ideas.
Use formatting like *emphasis* where appropriate.
`;
};

const getJudgeInstruction = (config) => {
  let judgePersona = "";
  switch(config.judge || 'impartial') {
    case 'sarcastic':
      judgePersona = "You are a sarcastic, witty judge who roasts the participants while scoring them. Be mean but funny.";
      break;
    case 'harsh':
      judgePersona = "You are a strictly professional and very harsh judge. You hate logical fallacies and demand high standards. Give low scores if they fail.";
      break;
    case 'constructive':
      judgePersona = "You are a kind, teacher-like judge. Focus on growth and provide very constructive feedback.";
      break;
    case 'impartial':
    default:
      judgePersona = "You are an impartial, expert debate judge.";
      break;
  }

  return `
${judgePersona}
Analyze the conversation transcript provided.
Score both participants (Persona A and Persona B) on three criteria:
1. Logic (Logical consistency and reasoning)
2. Evidence (Use of examples, facts, or strong theoretical backing)
3. Novelty (Creativity of arguments and wit)
Scores should be out of 10.
Provide a one-sentence critique for each.
`;
};

// --- API 路由 ---

/**
 * 1. 生成辩论角色
 * @route POST /api/debater/generate-personas
 */
router.post('/generate-personas', async (req, res) => {
  const { topic, lang = 'zh' } = req.body;
  if (!topic) return res.status(400).json({ msg: "Missing topic" });

  const langInstruction = lang === 'zh' ? "Provide names, roles, descriptions and styles in Chinese (Simplified)." : "Provide output in English.";
  
  const prompt = `
    Topic: "${topic}"
    
    Create two distinct personas to debate this topic.
    Persona A should generally support the affirmative or a specific dominant viewpoint.
    Persona B should support the negative or an opposing specific viewpoint.
    
    Ensure they have deep backgrounds. 
    
    CRITICAL: Assign a specific ARCHETYPE to each.
    Archetype Examples: 
    - The Doomer (Pessimistic, fatalistic)
    - The Futurist (Obsessed with tech progress)
    - The Traditionalist (Values old ways)
    - The Contrarian (Argues just to argue)
    - The Corporate Shill (Defends business interests)
    - The Academic (Pedantic, uses big words)
    - The Conspiracy Theorist (Connects unrelated dots)
    - The Compassionate Activist (Emotional appeal)
    
    Assign a unique 'style' (speaking style) that matches the archetype.
    
    ${langInstruction}
    
    Return strictly a JSON object with this structure:
    {
      "personaA": {
        "name": "Name",
        "role": "Short Title (e.g. Traditionalist)",
        "description": "Personality description including background and bias",
        "avatar": "Single Emoji",
        "style": "Speaking style description"
      },
      "personaB": {
        "name": "Name",
        "role": "Short Title",
        "description": "Personality description including background and bias",
        "avatar": "Single Emoji",
        "style": "Speaking style description"
      }
    }
  `;

  const schema = {
    type: Type.OBJECT,
    properties: {
      personaA: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          role: { type: Type.STRING },
          description: { type: Type.STRING },
          avatar: { type: Type.STRING },
          style: { type: Type.STRING }
        },
        required: ["name", "role", "description", "avatar", "style"]
      },
      personaB: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          role: { type: Type.STRING },
          description: { type: Type.STRING },
          avatar: { type: Type.STRING },
          style: { type: Type.STRING }
        },
        required: ["name", "role", "description", "avatar", "style"]
      }
    },
    required: ["personaA", "personaB"]
  };

  try {
    const data = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema);
    res.json({
      success: true,
      data: {
        A: { ...data.personaA, id: 'A', color: 'blue' },
        B: { ...data.personaB, id: 'B', color: 'red' }
      }
    });
  } catch (error) {
    console.error("Error generating personas:", error);
    res.status(500).json({ success: false, msg: "AI model failed to generate personas." });
  }
});

/**
 * 2. 生成辩论回合 (Turn Generation)
 * @route POST /api/debater/generate-turn
 */
router.post('/generate-turn', async (req, res) => {
  const { topic, currentPersona, opponentPersona, history = [], lang = 'zh', config = {}, modifier } = req.body;
  if (!topic || !currentPersona || !opponentPersona) return res.status(400).json({ msg: "Missing required fields" });

  const conversationLog = history
    .filter(m => m.senderId !== 'System')
    .map(m => {
      if (m.senderId === 'User') return `[Audience Member Interjects]: ${m.text || m.content}`;
      if (m.senderId === 'Audience') return `[Audience Commentary]: ${m.text || m.content}`;
      const name = m.senderId === 'A' ? "Side A" : "Side B"; 
      return `[${name}]: ${m.text || m.content}`;
    })
    .join("\n");

  const langInstruction = lang === 'zh' ? "Respond in Chinese (Simplified) strictly." : "Respond in English strictly.";
  const interventionInstruction = modifier 
    ? `\n!!! SPECIAL INTERVENTION: The moderator has imposed a constraint: "${modifier}". YOU MUST OBEY THIS MODIFIER FOR THIS TURN ONLY. !!!\n` 
    : "";

  const prompt = `
    Current Debate Topic: "${topic}"
    
    You are acting as:
    Name: ${currentPersona.name}
    Role: ${currentPersona.role}
    Stance: ${currentPersona.description}
    Speaking Style: ${currentPersona.style}
    
    Your Opponent is:
    Name: ${opponentPersona.name}
    Role: ${opponentPersona.role}
    
    Conversation History:
    ${conversationLog}
    
    INSTRUCTIONS:
    - ${langInstruction}
    - Respond to the last message (or start the debate if history is empty).
    - If the last message was from the user (Audience Member), address their point while maintaining your stance against your opponent.
    - Be witty, sharp, and in-character. 
    - Do not repeat yourself.
    ${interventionInstruction}
  `;

  const ai = getAiClient('default');

  try {
    const response = await ai.models.generateContent({
      model: CONFIG.PRIMARY_MODEL,
      contents: prompt,
      config: {
        systemInstruction: getDebaterInstruction(config)
      }
    });
    res.json({ success: true, text: response.text || "..." });
  } catch (error) {
    console.error("Error generating turn:", error);
    res.status(500).json({ success: false, msg: "Failed to generate debate turn." });
  }
});

/**
 * 3. 语音合成 (TTS)
 * @route POST /api/debater/generate-speech
 */
router.post('/generate-speech', async (req, res) => {
  const { text, voiceName = 'Aoide' } = req.body;
  if (!text) return res.status(400).json({ msg: "Missing text" });

  const ai = getAiClient('default');

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });
    const audioContent = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
    res.json({ success: true, audioBase64: audioContent });
  } catch (e) {
    console.error("TTS generation failed", e);
    res.status(500).json({ success: false, msg: "TTS conversion failed." });
  }
});

/**
 * 4. 辩论评估 (Judge Evaluation)
 * @route POST /api/debater/evaluate
 */
router.post('/evaluate', async (req, res) => {
  const { topic, history = [], lang = 'zh', config = {} } = req.body;
  
  const conversationLog = history
    .filter(m => ['A', 'B'].includes(m.senderId))
    .map(m => `[${m.senderId}]: ${m.text || m.content}`)
    .join("\n");

  const langInstruction = lang === 'zh' ? "Provide comments in Chinese (Simplified)." : "Provide comments in English.";

  const prompt = `
    Topic: ${topic}
    
    Transcript:
    ${conversationLog}
    
    Evaluate the performance of A and B. ${langInstruction} Return JSON only.
  `;

  const schema = {
    type: Type.OBJECT,
    properties: {
      scores: {
        type: Type.OBJECT,
        properties: {
          A: {
             type: Type.OBJECT,
             properties: {
               logic: { type: Type.INTEGER },
               evidence: { type: Type.INTEGER },
               novelty: { type: Type.INTEGER },
               total: { type: Type.INTEGER },
               comment: { type: Type.STRING }
             }
          },
          B: {
             type: Type.OBJECT,
             properties: {
               logic: { type: Type.INTEGER },
               evidence: { type: Type.INTEGER },
               novelty: { type: Type.INTEGER },
               total: { type: Type.INTEGER },
               comment: { type: Type.STRING }
             }
          }
        }
      },
      winner: { type: Type.STRING, enum: ["A", "B", "Tie"] }
    }
  };

  try {
    const data = await generateJSON(prompt, CONFIG.PRIMARY_MODEL, schema);
    res.json({ success: true, data });
  } catch (e) {
    console.error("Evaluation failed", e);
    res.status(500).json({ success: false, msg: "Evaluation failed." });
  }
});

/**
 * 5. 观众评论 (Audience Commentary)
 * @route POST /api/debater/audience-comment
 */
router.post('/audience-comment', async (req, res) => {
  const { topic, lastMessage, lang = 'zh' } = req.body;
  if (!topic || !lastMessage) return res.status(400).json({ msg: "Missing fields" });

  const ai = getAiClient('default');
  const langContext = lang === 'zh' ? "in Chinese (Simplified)" : "in English";

  try {
     const response = await ai.models.generateContent({
      model: CONFIG.PRIMARY_MODEL,
      contents: `Context: A debate about "${topic}". Last argument: "${lastMessage}". 
      Generate a very short (1-5 words) audience reaction ${langContext}. 
      Examples: "Agreed!", "What?", "No evidence!", "Exactly.", "Boo!", "Compelling point."`,
    });
    res.json({ success: true, text: response.text?.trim() || "..." });
  } catch (error) {
    res.status(500).json({ success: false, msg: "Comment failed" });
  }
});

export default router;
