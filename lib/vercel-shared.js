const META_API_VERSION = process.env.META_API_VERSION || 'v25.0';
const PLACES_RATE_LIMIT = Math.max(1, Number(process.env.PLACES_RATE_LIMIT || 10));
const PLACES_DAILY_LIMIT = Math.max(1, Number(process.env.PLACES_DAILY_LIMIT || 250));
const PLACES_CACHE_SECONDS = Math.max(60, Math.round(Number(process.env.PLACES_CACHE_MS || 900000) / 1000));

const memory = {
  buckets: new Map(),
  cache: new Map(),
  daily: { date: new Date().toISOString().slice(0, 10), count: 0 }
};

const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV',
  'LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','UK'
]);

function sendJson(res, status, payload, headers = {}) {
  Object.entries(headers).forEach(([name, value]) => res.setHeader(name, String(value)));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

function methodNotAllowed(res) {
  return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function sanitizeQuery(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeCountry(country) {
  const value = String(country || 'AU').trim().toUpperCase();
  return value === 'UK' ? 'GB' : value;
}

function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  if (!redisConfigured()) return null;
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Upstash request failed');
  return data.result;
}

async function rateLimit(req, scope, maxRequests, windowSeconds) {
  const ip = clientIp(req).replace(/[^a-zA-Z0-9:._-]/g, '');
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `leadscout:rate:${scope}:${ip}:${windowId}`;

  if (redisConfigured()) {
    const count = Number(await redisCommand(['INCR', key]));
    if (count === 1) await redisCommand(['EXPIRE', key, windowSeconds]);
    return { allowed: count <= maxRequests, remaining: Math.max(0, maxRequests - count), resetAt: (windowId + 1) * windowSeconds };
  }

  const now = Date.now();
  const current = memory.buckets.get(key) || { count: 0, resetAt: now + windowSeconds * 1000 };
  current.count += 1;
  memory.buckets.set(key, current);
  return {
    allowed: current.count <= maxRequests,
    remaining: Math.max(0, maxRequests - current.count),
    resetAt: Math.ceil(current.resetAt / 1000)
  };
}

async function consumeDailyPlacesRequest() {
  const date = new Date().toISOString().slice(0, 10);
  if (redisConfigured()) {
    const key = `leadscout:places:daily:${date}`;
    const count = Number(await redisCommand(['INCR', key]));
    if (count === 1) await redisCommand(['EXPIRE', key, 172800]);
    return { allowed: count <= PLACES_DAILY_LIMIT, count };
  }

  if (memory.daily.date !== date) memory.daily = { date, count: 0 };
  memory.daily.count += 1;
  return { allowed: memory.daily.count <= PLACES_DAILY_LIMIT, count: memory.daily.count };
}

async function getCache(key) {
  if (redisConfigured()) {
    const value = await redisCommand(['GET', `leadscout:cache:${key}`]);
    return value ? JSON.parse(value) : null;
  }
  const value = memory.cache.get(key);
  if (!value || value.expiresAt <= Date.now()) return null;
  return value.data;
}

async function setCache(key, data) {
  if (redisConfigured()) {
    await redisCommand(['SET', `leadscout:cache:${key}`, JSON.stringify(data), 'EX', PLACES_CACHE_SECONDS]);
    return;
  }
  memory.cache.set(key, { data, expiresAt: Date.now() + PLACES_CACHE_SECONDS * 1000 });
}

function stableCacheKey(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url').slice(0, 180);
}

module.exports = {
  EU_COUNTRIES,
  META_API_VERSION,
  PLACES_DAILY_LIMIT,
  PLACES_RATE_LIMIT,
  consumeDailyPlacesRequest,
  getCache,
  methodNotAllowed,
  normalizeCountry,
  rateLimit,
  redisConfigured,
  sanitizeQuery,
  sendJson,
  setCache,
  stableCacheKey
};
