import { fetch } from 'undici';

export const CLOUDFLARE_TEXT_MODEL =
  process.env.CLOUDFLARE_PORTFOLIO_TEXT_MODEL || '@cf/zai-org/glm-4.7-flash';

export const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_PORTFOLIO_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';

function getCloudflareAiConfig(explicitToken, explicitAccountId) {
  const accountId =
    explicitAccountId ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    process.env.R2_ACCOUNT_ID;
  const apiToken =
    explicitToken ||
    process.env.CLOUDFLARE_AI_TOKEN ||
    process.env.CLOUDFLARE_WORKERS_AI_TOKEN;

  if (!accountId || !apiToken) {
    const error = new Error(
      'Cloudflare Workers AI direct API is not configured. Provide Account ID + API token, or configure the Orion AI gateway.'
    );
    error.code = 'CLOUDFLARE_AI_NOT_CONFIGURED';
    throw error;
  }

  return { accountId, apiToken };
}

function getGatewayConfig() {
  const url = process.env.CLOUDFLARE_AI_GATEWAY_URL;
  const secret = process.env.CLOUDFLARE_AI_GATEWAY_SECRET;
  return url && secret ? { url: url.replace(/\/$/, ''), secret } : null;
}

async function callGateway(path, body) {
  const gateway = getGatewayConfig();
  if (!gateway) return null;

  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-orion-ai-secret': gateway.secret
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Orion AI gateway failed: ${response.status}`);
  }

  return payload;
}

function extractJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  const text = String(value || '').trim();
  if (!text) throw new Error('Cloudflare AI returned an empty response');

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
    const candidate = fenced?.[1]?.trim() || text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }

    throw new Error('Cloudflare AI did not return valid JSON');
  }
}

export async function generateCloudflareJson({
  system,
  prompt,
  explicitToken,
  explicitAccountId,
  model = CLOUDFLARE_TEXT_MODEL,
  maxTokens = 2600,
  schema
}) {
  if (!explicitToken) {
    const gatewayPayload = await callGateway('/text', {
      model,
      system,
      prompt,
      maxTokens,
      schema
    });
    if (gatewayPayload) return extractJsonObject(gatewayPayload.content);
  }

  const { accountId, apiToken } = getCloudflareAiConfig(explicitToken, explicitAccountId);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              system ||
              'Return only valid JSON. Do not include markdown fences or commentary.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_completion_tokens: maxTokens,
        response_format: schema
          ? {
              type: 'json_schema',
              json_schema: schema
            }
          : { type: 'json_object' }
      })
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.error?.message ||
      `Cloudflare Workers AI request failed: ${response.status}`;
    throw new Error(message);
  }

  const content = payload?.choices?.[0]?.message?.content;
  return extractJsonObject(content);
}

export async function generateCloudflareImage({
  prompt,
  explicitToken,
  explicitAccountId,
  model = CLOUDFLARE_IMAGE_MODEL
}) {
  if (!explicitToken) {
    const gatewayPayload = await callGateway('/image', { model, prompt });
    if (gatewayPayload?.image) {
      return {
        dataUrl: `data:image/jpeg;base64,${gatewayPayload.image}`,
        mimeType: gatewayPayload.mimeType || 'image/jpeg',
        model: gatewayPayload.model || model,
        provider: gatewayPayload.provider || 'cloudflare-workers-ai'
      };
    }
  }

  const { accountId, apiToken } = getCloudflareAiConfig(explicitToken, explicitAccountId);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        steps: 4,
        seed: Math.floor(Math.random() * 2147483647)
      })
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || !payload?.result?.image) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.messages?.[0]?.message ||
      `Cloudflare Workers AI image request failed: ${response.status}`;
    throw new Error(message);
  }

  return {
    dataUrl: `data:image/jpeg;base64,${payload.result.image}`,
    mimeType: 'image/jpeg',
    model,
    provider: 'cloudflare'
  };
}
