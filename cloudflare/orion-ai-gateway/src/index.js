const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const unauthorized = () => json({ error: 'Unauthorized' }, 401);

const getTextContent = (result) =>
  result?.response ||
  result?.choices?.[0]?.message?.content ||
  result?.result?.response ||
  '';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const suppliedSecret = request.headers.get('x-orion-ai-secret');
    if (!env.ORION_AI_GATEWAY_SECRET || suppliedSecret !== env.ORION_AI_GATEWAY_SECRET) {
      return unauthorized();
    }

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    try {
      if (url.pathname === '/text') {
        const model = body.model || '@cf/google/gemma-4-26b-a4b-it';
        const request = {
          messages: [
            {
              role: 'system',
              content:
                body.system ||
                'Return only valid JSON. Do not include markdown fences or commentary.'
            },
            { role: 'user', content: body.prompt || '' }
          ],
          temperature: 0.1,
          max_completion_tokens: body.maxTokens || 3000,
          chat_template_kwargs: {
            enable_thinking: false
          }
        };

        if (body.schema) {
          request.response_format = {
            type: 'json_schema',
            json_schema: body.schema
          };
        } else {
          request.response_format = { type: 'json_object' };
        }

        const result = await env.AI.run(model, request);

        const content = getTextContent(result);
        if (!content) {
          const finishReason = result?.choices?.[0]?.finish_reason || null;
          return json(
            {
              error:
                finishReason === 'length'
                  ? 'Workers AI exhausted its completion budget before producing final JSON'
                  : 'Workers AI returned empty text',
              finishReason
            },
            502
          );
        }

        return json({
          content,
          model,
          provider: 'cloudflare-workers-ai',
          structured: typeof content === 'object' && content !== null
        });
      }

      if (url.pathname === '/image') {
        const model = body.model || '@cf/black-forest-labs/flux-1-schnell';
        const result = await env.AI.run(model, {
          prompt: body.prompt || '',
          steps: 4,
          seed: Math.floor(Math.random() * 2147483647)
        });

        if (!result?.image) return json({ error: 'Workers AI returned no image' }, 502);

        return json({
          image: result.image,
          mimeType: 'image/jpeg',
          model,
          provider: 'cloudflare-workers-ai'
        });
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error?.message || 'Workers AI request failed' }, 500);
    }
  }
};
