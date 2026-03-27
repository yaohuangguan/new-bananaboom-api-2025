import { Router } from 'express';
import { Type } from '@google/genai';
import { getAiClient, CONFIG, generateJSON } from '../utils/aiProvider.js';

const router = Router();

// System prompt as provided in frontend code
const SYSTEM_PROMPT = `
You are an expert at structuring disorganized spoken thoughts into clear, logical, hierarchical mind maps.
Your goal is to extract entities, actions, and relationships from the audio transcript and organize them into a strict JSON tree structure.

Rules:
1. Identify the main topic as the root node.
2. Group related concepts into branches.
3. Keep labels concise (2-5 words).
4. Add 'details' if there is specific extra info (dates, prices, specific items).
5. Assign a 'category' to each node from these options: 'idea' (general concept), 'task' (action item), 'question' (uncertainty), 'fact' (statement).
6. Assign a unique string ID to every node.
7. Return ONLY the JSON object.
`;

/**
 * 1. 语音生成思维导图
 * @route POST /api/voice2map/generate
 */
router.post('/generate', async (req, res) => {
  const { audioBase64 } = req.body;
  if (!audioBase64) return res.status(400).json({ msg: "Missing audioBase64" });

  const ai = getAiClient('default');
  
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      root: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          label: { type: Type.STRING },
          details: { type: Type.STRING },
          category: { type: Type.STRING, enum: ['idea', 'task', 'question', 'fact'] },
          children: { 
            type: Type.ARRAY, 
            items: { type: Type.OBJECT } // Recursive structure, simplified schema
          }
        },
        required: ["id", "label", "category"]
      }
    },
    required: ["root"]
  };

  try {
    const chat = ai.chats.create({
      model: CONFIG.PRIMARY_MODEL,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        thinkingConfig: {
          thinkingBudget: 32768 
        }
      }
    });

    const result = await chat.sendMessage({
      message: [
        {
          inlineData: {
            mimeType: 'audio/mp3', 
            data: audioBase64
          }
        },
        {
          text: "Listen to this audio. Structurally organize these thoughts into a Mind Map JSON with a 'root' object containing 'id', 'label', 'details', 'category', and 'children' array."
        }
      ]
    });

    const jsonText = result.text;
    if (!jsonText) throw new Error("No text response from Gemini");

    // Re-use current backend cleaning logic just in case
    const parsedData = JSON.parse(jsonText);
    
    if (!parsedData.root) {
      throw new Error("Invalid JSON structure: missing root");
    }

    // Recursively add timestamps as per frontend requirements
    const augmentNode = (node) => {
      if (!node.createdAt) node.createdAt = Date.now();
      if (node.children && Array.isArray(node.children)) {
          node.children.forEach(augmentNode);
      }
    };
    augmentNode(parsedData.root);

    res.json({ success: true, data: parsedData });

  } catch (error) {
    console.error("Voice2Map generate error:", error);
    res.status(500).json({ success: false, msg: "AI model failed to process audio.", error: error.message });
  }
});

/**
 * 2. Google Search 知识增强
 * @route POST /api/voice2map/enrich-search
 */
router.post('/enrich-search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ msg: "Missing query" });

  const ai = getAiClient('default');

  try {
    const response = await ai.models.generateContent({
      model: CONFIG.PRIMARY_MODEL,
      contents: `Search for "${query}". Provide a 1-sentence summary of key facts.`,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const text = response.text || "";
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const links = chunks
      .filter((c) => c.web?.uri)
      .map((c) => ({ 
          title: c.web.title || 'Source', 
          url: c.web.uri 
      }));

    res.json({ success: true, data: { text, links } });
  } catch (e) {
    console.error("Search Grounding Error:", e);
    res.status(500).json({ success: false, msg: "Search enrichment failed.", error: e.message });
  }
});

/**
 * 3. Google Maps 地理位置增强
 * @route POST /api/voice2map/enrich-maps
 */
router.post('/enrich-maps', async (req, res) => {
  const { query, userLocation } = req.body;
  if (!query) return res.status(400).json({ msg: "Missing query" });

  const ai = getAiClient('default');

  try {
    const config = {
      tools: [{ googleMaps: {} }]
    };

    if (userLocation && userLocation.lat && userLocation.lng) {
        config.toolConfig = {
            retrievalConfig: {
                latLng: {
                    latitude: userLocation.lat,
                    longitude: userLocation.lng
                }
            }
        };
    }

    const response = await ai.models.generateContent({
      model: CONFIG.PRIMARY_MODEL,
      contents: `Find "${query}". Provide the address, rating, and a brief review snippet if available.`,
      config: config
    });

    const text = response.text || "";
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    
    // Maps grounding chunks structure
    const links = [];
    chunks.forEach((c) => {
        if (c.maps?.uri) {
            links.push({ 
                title: c.maps.title || 'Google Maps', 
                url: c.maps.uri 
            });
        }
    });

    res.json({ success: true, data: { text, links } });
  } catch (e) {
    console.error("Maps Grounding Error:", e);
    res.status(500).json({ success: false, msg: "Maps enrichment failed.", error: e.message });
  }
});

export default router;
