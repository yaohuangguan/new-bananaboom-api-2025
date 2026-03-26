import { Router } from 'express';
import { Type } from '@google/genai';
import { getAiClient, CONFIG, generateJSON } from '../utils/aiProvider.js';

const router = Router();

// --- RPG 核心 Schema 定义 ---
const gameResponseSchema = {
  type: Type.OBJECT,
  properties: {
    narrative: {
      type: Type.STRING,
      description: "The main story text. If the game ends, include the epilogue here.",
    },
    combatLog: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Combat events (e.g. 'Player hit for 15 dmg')."
    },
    state: {
      type: Type.OBJECT,
      properties: {
        hp: { type: Type.INTEGER },
        maxHp: { type: Type.INTEGER },
        money: { type: Type.INTEGER },
        inventory: { type: Type.ARRAY, items: { type: Type.STRING } },
        location: { type: Type.STRING },
        quests: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              status: { type: Type.STRING, enum: ['active', 'completed', 'failed'] }
            }
          }
        },
        inCombat: { type: Type.BOOLEAN },
        enemies: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              name: { type: Type.STRING },
              hp: { type: Type.INTEGER },
              maxHp: { type: Type.INTEGER },
              description: { type: Type.STRING }
            }
          }
        },
        abilities: { type: Type.ARRAY, items: { type: Type.STRING } },
        gameStatus: { 
          type: Type.STRING, 
          enum: ['playing', 'victory', 'defeat'],
          description: "Current status. Set to 'victory' or 'defeat' when the story concludes." 
        },
        narrativeProgress: { 
          type: Type.INTEGER,
          description: "An integer from 0 to 100 indicating how close the game is to the ending."
        },
        narrativeLabel: {
          type: Type.STRING,
          description: "The name of the progress bar, e.g., 'Cyberpsychosis', 'Corruption', 'Time Until Detonation', 'Quest Completion'."
        },
        endingSummary: {
          type: Type.STRING,
          description: "If gameStatus is victory/defeat, provide a 1-2 sentence summary of the outcome."
        }
      },
      required: ["hp", "maxHp", "money", "inventory", "location", "quests", "inCombat", "enemies", "abilities", "gameStatus", "narrativeProgress", "narrativeLabel"]
    },
    choices: { type: Type.ARRAY, items: { type: Type.STRING } },
    visualEffect: {
      type: Type.STRING,
      enum: ['none', 'glitch', 'shake_small', 'shake_heavy', 'flash_red', 'flash_white', 'scan_line', 'target_flash'],
      description: "Screen effect based on context."
    },
    audioCue: {
      type: Type.STRING,
      enum: ['none', 'combat_start', 'combat_end', 'item_pickup', 'damage', 'quest_update', 'game_over', 'game_won'],
    },
    textStyle: {
      type: Type.STRING,
      enum: ['normal', 'corrupted', 'system_log'],
      description: "Style of the narrative text."
    }
  },
  required: ["narrative", "state", "choices", "visualEffect", "audioCue", "textStyle"]
};

/**
 * 助手：获取系统指令
 */
const getSystemInstruction = (config) => {
  const langInstruction = config.language === 'zh' 
    ? "Language: Simplified Chinese (简体中文). Response must be in Chinese." 
    : "Language: English. Response must be in English.";

  const themeInstruction = `Theme: ${config.theme}. Player Character: ${config.characterType}. Adjust currency, items, abilities, and the 'narrativeLabel' to match this theme.`;

  return `You are the AI Game Master for a TEXT RPG with a DEFINITIVE ENDING.
      
      Configuration:
      ${langInstruction}
      ${themeInstruction}

      IMPORTANT - FINITE GAMEPLAY RULES:
      1. **NO INFINITE LOOPS**: The game must have a clear beginning, middle, and end.
      2. **Narrative Progress**: Manage 'narrativeProgress' from 0 to 100.
         - 0-30: Intro & Rising Action.
         - 30-70: Main Challenges & Combat.
         - 70-90: Climax / Boss Fight.
         - 100: Conclusion.
      3. **Winning & Losing**:
         - **Defeat**: If HP reaches 0, or the player makes a catastrophic choice, set 'gameStatus' to 'defeat'.
         - **Victory**: If the player completes the main objective and progress reaches 100, set 'gameStatus' to 'victory'.
         - **Ending**: When status is 'victory' or 'defeat', provide a final wrap-up in 'narrative' and a summary in 'endingSummary'. Clear 'choices'.

      Visual & Text Style Rules:
      - USE 'visualEffect' heavily to immerse the player.
      - USE 'textStyle' to match the narrative voice.
      
      Start State: HP 100/100, Money 100, Inventory [Basic Item], GameStatus 'playing', Progress 0.
      
      Intro: Start the game by describing the opening scene and the ULTIMATE GOAL.`;
};

// --- API 路由 ---

/**
 * 1. 初始化游戏
 * @route POST /api/rpg/initialize
 */
router.post('/initialize', async (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ msg: "Missing game config" });

  const ai = getAiClient('default');
  const systemInstruction = getSystemInstruction(config);
  
  try {
    const chat = ai.chats.create({
      model: CONFIG.PRIMARY_MODEL,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        responseSchema: gameResponseSchema,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const result = await chat.sendMessage("Start Game");
    const text = result.text;
    if (!text) throw new Error("Empty response from AI");
    
    const parsed = JSON.parse(text);
    res.json({ success: true, data: parsed });
  } catch (error) {
    console.error("Failed to initialize game:", error);
    res.status(500).json({ success: false, msg: "AI GM failed to start game." });
  }
});

/**
 * 2. 处理玩家动作 (无状态 Action)
 * @route POST /api/rpg/action
 */
router.post('/action', async (req, res) => {
  const { action, config, history = [] } = req.body;
  if (!action || !config) return res.status(400).json({ msg: "Missing action or config" });

  const ai = getAiClient('default');
  const systemInstruction = getSystemInstruction(config);

  try {
    const chat = ai.chats.create({
      model: CONFIG.PRIMARY_MODEL,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        responseSchema: gameResponseSchema,
        thinkingConfig: { thinkingBudget: 0 }
      },
      history: history
    });

    const result = await chat.sendMessage(action);
    const text = result.text;
    if (!text) throw new Error("Empty response from AI");
    
    const parsed = JSON.parse(text);
    res.json({ success: true, data: parsed });
  } catch (error) {
    console.error("RPG Turn Error:", error);
    res.status(500).json({ success: false, msg: "GM encountered an error processing your choice." });
  }
});

export default router;
