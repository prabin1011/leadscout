const {
  META_API_VERSION,
  PLACES_DAILY_LIMIT,
  PLACES_RATE_LIMIT,
  redisConfigured,
  sendJson
} = require('../lib/vercel-shared');

module.exports = async function handler(req, res) {
  return sendJson(res, 200, {
    ok: true,
    runtime: 'vercel',
    googlePlacesConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    metaApiVersion: META_API_VERSION,
    placesRateLimitPerMinute: PLACES_RATE_LIMIT,
    placesDailyLimit: PLACES_DAILY_LIMIT,
    persistentRateLimitConfigured: redisConfigured()
  });
};
