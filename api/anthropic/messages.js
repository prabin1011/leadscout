const { methodNotAllowed, rateLimit, sendJson } = require('../../lib/vercel-shared');

const ALLOWED_MAX_TOKENS = 4000;
const TASKS = new Set(['general', 'outreach', 'campaign', 'website']);

function modelForTask(task) {
  if (task === 'website') return process.env.FABLE_MODEL || 'claude-fable-5';
  if (task === 'campaign') return process.env.CAMPAIGN_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
}

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };
const OUTPUT_SCHEMAS = {
  outreach: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      ps: { type: 'string' }
    },
    required: ['subject', 'body', 'ps'],
    additionalProperties: false
  },
  campaign: {
    type: 'object',
    properties: {
      campaignName: { type: 'string' },
      objective: { type: 'string' },
      strategySummary: { type: 'string' },
      verifiedInputs: STRING_ARRAY,
      hypotheses: STRING_ARRAY,
      offer: { type: 'string' },
      budgetSplit: { type: 'string' },
      headlines: STRING_ARRAY,
      descriptions: STRING_ARRAY,
      keywords: STRING_ARRAY,
      negativeKeywords: STRING_ARRAY,
      audiences: STRING_ARRAY,
      creativeConcepts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            hook: { type: 'string' },
            angle: { type: 'string' },
            visual: { type: 'string' },
            cta: { type: 'string' }
          },
          required: ['name', 'hook', 'angle', 'visual', 'cta'],
          additionalProperties: false
        }
      },
      landingPagePlan: STRING_ARRAY,
      bidStrategy: { type: 'string' },
      adSchedule: { type: 'string' },
      measurement: STRING_ARRAY,
      experiments: STRING_ARRAY,
      estimatedResults: { type: 'string' },
      quickWins: STRING_ARRAY
    },
    required: [
      'campaignName', 'objective', 'strategySummary', 'verifiedInputs', 'hypotheses',
      'offer', 'budgetSplit', 'headlines', 'descriptions', 'keywords',
      'negativeKeywords', 'audiences', 'creativeConcepts', 'landingPagePlan',
      'bidStrategy', 'adSchedule', 'measurement', 'experiments',
      'estimatedResults', 'quickWins'
    ],
    additionalProperties: false
  }
};

async function createMessage(apiKey, model, prompt, maxTokens, task) {
  const schema = OUTPUT_SCHEMAS[task];
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
      messages: [{ role: 'user', content: prompt }],
      ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {})
    })
  });
  return { response, data: await response.json() };
}

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
  const requestedTask = String(req.body?.task || 'general').trim().toLowerCase();
  const task = TASKS.has(requestedTask) ? requestedTask : 'general';
  const maxTokens = Math.max(100, Math.min(Number(req.body?.maxTokens || 900), ALLOWED_MAX_TOKENS));
  if (!prompt || prompt.length > 30000) {
    return sendJson(res, 400, { ok: false, reason: 'invalid_prompt' });
  }

  const model = modelForTask(task);
  try {
    let result = await createMessage(apiKey, model, prompt, maxTokens, task);
    let fallback = false;
    const fallbackModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    if (task === 'website' && !result.response.ok && model !== fallbackModel && [400, 404].includes(result.response.status)) {
      result = await createMessage(apiKey, fallbackModel, prompt, maxTokens, task);
      fallback = true;
    }
    return sendJson(res, result.response.status, {
      ...result.data,
      leadscout: {
        task,
        requestedModel: model,
        usedModel: result.data.model || (fallback ? fallbackModel : model),
        fallback
      }
    });
  } catch (error) {
    return sendJson(res, 502, { ok: false, reason: 'anthropic_request_failed', message: error.message });
  }
};
