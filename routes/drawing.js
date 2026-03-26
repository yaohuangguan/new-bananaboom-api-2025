import { Router } from 'express';
import { getAiClient, CONFIG } from '../utils/aiProvider.js';

const router = Router();

// VectorVerse Role System Instruction
const SYSTEM_INSTRUCTION = `
You are VectorVerse, an expert AI SVG generator and assistant.
Your goal is to generate clean, efficient, and visually appealing SVG code based on user requests.

RULES:
1. Output ONLY the raw SVG code. Do not wrap it in markdown code blocks (e.g., no \`\`\`svg ... \`\`\`).
2. Do not include any explanatory text before or after the code unless the user explicitly asks for an explanation. The output should be directly renderable.
3. If the user asks to modify existing SVG, strictly adhere to their modification request while maintaining the integrity of the rest of the image.
4. Ensure the SVG has a 'xmlns="http://www.w3.org/2000/svg"' attribute.
5. Default to a viewBox of "0 0 512 512" if size is not specified.
6. Use semantic IDs and classes where helpful.
7. Be creative! If the user gives a vague prompt (e.g., "cool abstract background"), use your reasoning capabilities to design something complex and beautiful.
`;

/**
 * AI SVG 生成与修改
 * @route POST /api/drawing/generate
 */
router.post('/generate', async (req, res) => {
  const { prompt, currentCode = "" } = req.body;
  if (!prompt) return res.status(400).json({ msg: "Missing prompt" });

  const ai = getAiClient('default');
  
  // Construct the full prompt context
  const fullPrompt = `
  Current SVG Code:
  ${currentCode}

  User Request:
  ${prompt}

  Generate the updated or new SVG code now.
  `;

  try {
    const response = await ai.models.generateContent({
      model: CONFIG.PRIMARY_MODEL,
      contents: fullPrompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        // High thinking budget for complex visual reasoning, even on Flash models
        thinkingConfig: {
            thinkingBudget: 32768, 
        }
      }
    });

    if (response.text) {
        // AI may still accidentally output markdown backticks occasionally despite instruction
        // We clean it just to be safe
        let svgCode = response.text.trim();
        if (svgCode.startsWith('```')) {
            svgCode = svgCode.replace(/^```[a-z]*\n/i, '').replace(/\n```$/m, '');
        }
        return res.json({ success: true, data: svgCode });
    }
    
    throw new Error("No response generated");

  } catch (error) {
    console.error("VectorVerse Error:", error);
    res.status(500).json({ success: false, msg: "Failed to generate SVG.", error: error.message });
  }
});

export default router;
