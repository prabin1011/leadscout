const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const PORT = Number(process.env.PORT || 8765);
const HOST = '127.0.0.1';
const APP_FILE = process.env.LEADSCOUT_HTML || path.join(__dirname, 'leadscout_v3.html');
const META_API_VERSION = process.env.META_API_VERSION || 'v25.0';
const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
const PLACES_RATE_LIMIT = Math.max(1, Number(process.env.PLACES_RATE_LIMIT || 10));
const PLACES_DAILY_LIMIT = Math.max(1, Number(process.env.PLACES_DAILY_LIMIT || 250));
const PLACES_CACHE_MS = Math.max(60_000, Number(process.env.PLACES_CACHE_MS || 900_000));

const requestBuckets = new Map();
const placesCache = new Map();
let placesDailyUsage = { date: new Date().toISOString().slice(0, 10), count: 0 };

const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV',
  'LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','UK'
]);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function normalizeCountry(country) {
  const c = String(country || 'AU').trim().toUpperCase();
  return c === 'UK' ? 'GB' : c;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, scope, maxRequests, windowMs) {
  const now = Date.now();
  const key = `${scope}:${clientIp(req)}`;
  const current = requestBuckets.get(key);
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    requestBuckets.set(key, next);
    return { allowed: true, remaining: maxRequests - 1, resetAt: next.resetAt };
  }
  if (current.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt };
  }
  current.count += 1;
  return { allowed: true, remaining: maxRequests - current.count, resetAt: current.resetAt };
}

function checkDailyPlacesLimit() {
  const today = new Date().toISOString().slice(0, 10);
  if (placesDailyUsage.date !== today) {
    placesDailyUsage = { date: today, count: 0 };
  }
  if (placesDailyUsage.count >= PLACES_DAILY_LIMIT) return false;
  placesDailyUsage.count += 1;
  return true;
}

function sanitizeQuery(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizePlacesQuery({ query, keyword, location }) {
  let intent = sanitizeQuery(query || keyword, 180);
  const area = sanitizeQuery(location, 120);
  intent = intent
    .replace(/^(?:please\s+)?(?:search|find|show|look)\s+(?:for\s+|me\s+)?/i, '')
    .replace(/^places?\s+(?:for\s+)?/i, '')
    .trim();
  if (!intent) return '';
  if (!area) return intent;
  const normalizedIntent = intent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const normalizedArea = area.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return normalizedArea && normalizedIntent.includes(normalizedArea) ? intent : `${intent} in ${area}`;
}

async function handlePlacesSearch(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  }

  const rate = checkRateLimit(req, 'places', PLACES_RATE_LIMIT, 60_000);
  res.setHeader('X-RateLimit-Limit', String(PLACES_RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))));
    return sendJson(res, 429, { ok: false, reason: 'rate_limited', message: 'Too many searches. Please wait before trying again.' });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return sendJson(res, 503, {
      ok: false,
      configured: false,
      reason: 'missing_google_maps_api_key',
      message: 'Set GOOGLE_MAPS_API_KEY on the backend. The key is never sent to the browser.'
    });
  }

  const raw = await readBody(req);
  const payload = raw ? JSON.parse(raw) : {};
  const query = sanitizeQuery(payload.query, 180);
  const keyword = sanitizeQuery(payload.keyword, 180);
  const location = sanitizeQuery(payload.location, 120);
  const count = Math.max(1, Math.min(Number(payload.count || 12), 20));
  const regionCode = sanitizeQuery(payload.regionCode, 2).toUpperCase();
  const pageToken = sanitizeQuery(payload.pageToken, 1000);
  const textQuery = normalizePlacesQuery({ query, keyword, location });

  if (!textQuery) {
    return sendJson(res, 400, {
      ok: false,
      reason: 'missing_query',
      message: 'Enter a business, category, service, address, or natural-language Maps search.'
    });
  }

  const cacheKey = JSON.stringify({ textQuery: textQuery.toLowerCase(), count, regionCode, pageToken });
  const cached = placesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return sendJson(res, 200, { ...cached.data, cached: true });
  }

  if (!checkDailyPlacesLimit()) {
    return sendJson(res, 429, {
      ok: false,
      reason: 'daily_limit_reached',
      message: `This server has reached its daily safety cap of ${PLACES_DAILY_LIMIT} Google Places requests.`
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.primaryType',
          'places.primaryTypeDisplayName',
          'places.businessStatus',
          'places.googleMapsUri',
          'places.rating',
          'places.userRatingCount',
          'places.nationalPhoneNumber',
          'places.websiteUri',
          'places.regularOpeningHours',
          'nextPageToken'
        ].join(',')
      },
      body: JSON.stringify({
        textQuery,
        pageSize: count,
        rankPreference: 'RELEVANCE',
        ...(pageToken ? { pageToken } : {}),
        ...(regionCode ? { regionCode } : {})
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return sendJson(res, response.status, {
        ok: false,
        configured: true,
        reason: 'google_places_error',
        message: data.error && data.error.message ? data.error.message : 'Google Places request failed.',
        details: data.error || data
      });
    }

    const result = {
      ok: true,
      configured: true,
      source: 'google_places_text_search',
      query: textQuery,
      count: Array.isArray(data.places) ? data.places.length : 0,
      places: data.places || [],
      nextPageToken: data.nextPageToken || '',
      cached: false
    };
    placesCache.set(cacheKey, { data: result, expiresAt: Date.now() + PLACES_CACHE_MS });
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      configured: true,
      reason: error.name === 'AbortError' ? 'google_places_timeout' : 'connector_exception',
      message: error.name === 'AbortError' ? 'Google Places request timed out.' : error.message
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleMetaAds(req, res, url) {
  let payload = {};
  if (req.method === 'POST') {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  }

  const name = String(payload.name || url.searchParams.get('name') || '').trim();
  const country = normalizeCountry(payload.country || url.searchParams.get('country') || 'AU');
  const token = String(payload.accessToken || process.env.META_ACCESS_TOKEN || '').trim();
  const limit = Math.max(1, Math.min(Number(payload.limit || url.searchParams.get('limit') || 8), 25));

  if (!name) {
    return sendJson(res, 400, { ok: false, verified: false, reason: 'missing_name' });
  }

  if (!token) {
    return sendJson(res, 200, {
      ok: false,
      verified: false,
      configured: false,
      source: 'meta_ad_library_api',
      reason: 'missing_meta_access_token',
      message: 'Set META_ACCESS_TOKEN on the backend, then rerun the scan.',
      publicUrl: 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + encodeURIComponent(country) + '&q=' + encodeURIComponent(name)
    });
  }

  const adType = EU_COUNTRIES.has(country) ? 'ALL' : 'POLITICAL_AND_ISSUE_ADS';
  const api = new URL(`https://graph.facebook.com/${META_API_VERSION}/ads_archive`);
  api.searchParams.set('search_terms', name);
  api.searchParams.set('ad_reached_countries', JSON.stringify([country]));
  api.searchParams.set('ad_type', adType);
  api.searchParams.set('limit', String(limit));
  api.searchParams.set('fields', [
    'id',
    'page_id',
    'page_name',
    'ad_delivery_start_time',
    'ad_delivery_stop_time',
    'ad_snapshot_url',
    'publisher_platforms'
  ].join(','));
  api.searchParams.set('access_token', token);

  try {
    const response = await fetch(api);
    const data = await response.json();

    if (!response.ok || data.error) {
      return sendJson(res, 200, {
        ok: false,
        verified: false,
        configured: true,
        source: 'meta_ad_library_api',
        reason: 'meta_api_error',
        adType,
        country,
        error: data.error || data,
        publicUrl: 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + encodeURIComponent(country) + '&q=' + encodeURIComponent(name)
      });
    }

    const ads = Array.isArray(data.data) ? data.data : [];
    return sendJson(res, 200, {
      ok: true,
      verified: true,
      configured: true,
      source: 'meta_ad_library_api',
      adType,
      country,
      name,
      activeAds: ads.filter(ad => !ad.ad_delivery_stop_time).length,
      totalReturned: ads.length,
      ads,
      paging: data.paging || null,
      coverageNote: EU_COUNTRIES.has(country)
        ? 'Meta API can return ads of any type delivered to the UK/EU during the past year.'
        : 'Outside UK/EU, Meta API coverage is mainly social issue, election, and political ads. Use the public library for broader active commercial-ad checks.'
    });
  } catch (error) {
    return sendJson(res, 200, {
      ok: false,
      verified: false,
      configured: true,
      source: 'meta_ad_library_api',
      reason: 'connector_exception',
      message: error.message
    });
  }
}

const ANTHROPIC_STRING_ARRAY = { type: 'array', items: { type: 'string' } };
const ANTHROPIC_OUTPUT_SCHEMAS = {
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
      budgetSplit: { type: 'string' },
      headlines: ANTHROPIC_STRING_ARRAY,
      descriptions: ANTHROPIC_STRING_ARRAY,
      keywords: ANTHROPIC_STRING_ARRAY,
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
      bidStrategy: { type: 'string' },
      adSchedule: { type: 'string' },
      estimatedResults: { type: 'string' },
      quickWins: ANTHROPIC_STRING_ARRAY
    },
    required: [
      'campaignName', 'objective', 'strategySummary', 'budgetSplit', 'headlines',
      'descriptions', 'keywords', 'creativeConcepts', 'bidStrategy', 'adSchedule',
      'estimatedResults', 'quickWins'
    ],
    additionalProperties: false
  }
};

async function handleAnthropic(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  }

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 503, {
      ok: false,
      reason: 'missing_anthropic_api_key',
      message: 'Set ANTHROPIC_API_KEY on the backend.'
    });
  }

  const raw = await readBody(req);
  const payload = raw ? JSON.parse(raw) : {};
  const prompt = String(payload.prompt || '').trim();
  const task = ['general', 'outreach', 'campaign', 'website'].includes(String(payload.task || '').toLowerCase())
    ? String(payload.task).toLowerCase()
    : 'general';
  const maxTokens = Math.max(100, Math.min(Number(payload.maxTokens || 900), 4000));
  if (!prompt || prompt.length > 30000) {
    return sendJson(res, 400, { ok: false, reason: 'invalid_prompt' });
  }

  try {
    const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const requestedModel = task === 'website'
      ? (process.env.FABLE_MODEL || 'claude-fable-5')
      : task === 'campaign'
        ? (process.env.CAMPAIGN_MODEL || defaultModel)
        : defaultModel;
    const outputSchema = ANTHROPIC_OUTPUT_SCHEMAS[task];
    async function createMessage(model) {
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
          ...(outputSchema ? {
            output_config: {
              format: { type: 'json_schema', schema: outputSchema }
            }
          } : {})
        })
      });
      return { response, data: await response.json(), model };
    }
    let result = await createMessage(requestedModel);
    let fallback = false;
    if (task === 'website' && !result.response.ok && requestedModel !== defaultModel && [400, 404].includes(result.response.status)) {
      result = await createMessage(defaultModel);
      fallback = true;
    }
    return sendJson(res, result.response.status, {
      ...result.data,
      leadscout: {
        task,
        requestedModel,
        usedModel: result.data.model || result.model,
        fallback
      }
    });
  } catch (error) {
    return sendJson(res, 502, { ok: false, reason: 'anthropic_request_failed', message: error.message });
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const p = address.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  const value = String(address || '').toLowerCase();
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
}

function htmlText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
}

function htmlMeta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (name && content && name[1].toLowerCase() === key.toLowerCase()) return htmlText(content[1]);
  }
  return '';
}

async function fetchPublicHtml(initialUrl, signal) {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const addresses = await dns.lookup(current.hostname, { all: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('private_address');
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'LeadScoutWebsiteAudit/1.0', Accept: 'text/html,application/xhtml+xml' }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current);
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || current.port) throw new Error('invalid_redirect');
  }
  throw new Error('too_many_redirects');
}

async function handleWebsiteAudit(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const raw = await readBody(req);
  const payload = raw ? JSON.parse(raw) : {};
  let target;
  try {
    target = new URL(String(payload.url || '').trim());
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.port) throw new Error();
  } catch {
    return sendJson(res, 400, { ok: false, reason: 'invalid_url', message: 'A public HTTP or HTTPS website URL is required.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchPublicHtml(target, controller.signal);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('text/html')) {
      return sendJson(res, 422, { ok: false, reason: 'website_unavailable', message: `Website returned ${response.status} or non-HTML content.` });
    }
    const html = (await response.text()).slice(0, 750_000);
    const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const headings = tag => (html.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')) || []).slice(0, tag === 'h1' ? 4 : 8).map(htmlText);
    return sendJson(res, 200, {
      ok: true,
      source: 'public_website_metadata',
      url: response.url,
      title: htmlText(title ? title[1] : ''),
      description: htmlMeta(html, 'description'),
      ogTitle: htmlMeta(html, 'og:title'),
      ogDescription: htmlMeta(html, 'og:description'),
      ogImage: htmlMeta(html, 'og:image'),
      themeColor: htmlMeta(html, 'theme-color'),
      h1: headings('h1'),
      h2: headings('h2'),
      hasViewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html),
      hasSchema: /application\/ld\+json/i.test(html),
      hasBookingLanguage: /\b(book|appointment|reserve|schedule|consultation)\b/i.test(html),
      hasContactForm: /<form\b/i.test(html)
    });
  } catch (error) {
    if (error.message === 'private_address') {
      return sendJson(res, 400, { ok: false, reason: 'private_address', message: 'Only public websites can be audited.' });
    }
    return sendJson(res, 502, { ok: false, reason: 'website_audit_failed', message: error.name === 'AbortError' ? 'Website audit timed out.' : error.message });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
        metaApiVersion: META_API_VERSION,
        anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        fableModel: process.env.FABLE_MODEL || 'claude-fable-5',
        googlePlacesConfigured: Boolean(GOOGLE_MAPS_API_KEY),
        placesRateLimitPerMinute: PLACES_RATE_LIMIT,
        placesDailyLimit: PLACES_DAILY_LIMIT,
        placesDailyUsed: placesDailyUsage.count
      });
    }

    if (url.pathname === '/api/places/search') {
      return await handlePlacesSearch(req, res);
    }

    if (url.pathname === '/api/meta-ads/search') {
      return await handleMetaAds(req, res, url);
    }

    if (url.pathname === '/api/anthropic/messages') {
      return await handleAnthropic(req, res);
    }

    if (url.pathname === '/api/website/audit') {
      return await handleWebsiteAudit(req, res);
    }

    if (url.pathname === '/' || url.pathname === '/leadscout_v3.html') {
      const html = fs.readFileSync(APP_FILE, 'utf8');
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    }

    const assetPath = path.join(path.dirname(APP_FILE), decodeURIComponent(url.pathname));
    if (assetPath.startsWith(path.dirname(APP_FILE)) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      return sendText(res, 200, fs.readFileSync(assetPath), 'application/octet-stream');
    }

    sendJson(res, 404, { ok: false, reason: 'not_found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, reason: 'server_error', message: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LeadScout preview running at http://${HOST}:${PORT}/leadscout_v3.html`);
  console.log(`Meta connector configured: ${Boolean(process.env.META_ACCESS_TOKEN)}`);
});
