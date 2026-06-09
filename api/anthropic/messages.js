const { methodNotAllowed, rateLimit, sendJson } = require('../../lib/vercel-shared');

const ALLOWED_MAX_TOKENS = 4000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const rate = await rateLimit(req, 'anthropic', 20, 60);
  if (!rate.allowed) {
    return sendJson(res, 429, { ok: false, reason: 'rate_limited', message: 'Too many AI generation requests.' });
  }

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 503, {
      ok: false,
      reason: 'missing_anthropic_api_key',
      message: 'ANTHROPIC_API_KEY is not configured on the deployment.'
    });
  }

  const prompt = String(req.body?.prompt || '').trim();
  const maxTokens = Math.max(100, Math.min(Number(req.body?.maxTokens || 900), ALLOWED_MAX_TOKENS));
  if (!prompt || prompt.length > 30000) {
    return sendJson(res, 400, { ok: false, reason: 'invalid_prompt' });
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    return sendJson(res, response.status, data);
  } catch (error) {
    return sendJson(res, 502, { ok: false, reason: 'anthropic_request_failed', message: error.message });
  }
};
