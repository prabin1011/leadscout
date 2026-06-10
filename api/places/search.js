const {
  PLACES_DAILY_LIMIT,
  PLACES_RATE_LIMIT,
  consumeDailyPlacesRequest,
  getCache,
  methodNotAllowed,
  normalizePlacesQuery,
  rateLimit,
  sanitizeQuery,
  sendJson,
  setCache,
  stableCacheKey
} = require('../../lib/vercel-shared');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const rate = await rateLimit(req, 'places', PLACES_RATE_LIMIT, 60);
  const rateHeaders = {
    'X-RateLimit-Limit': PLACES_RATE_LIMIT,
    'X-RateLimit-Remaining': rate.remaining,
    'X-RateLimit-Reset': rate.resetAt
  };
  if (!rate.allowed) {
    return sendJson(res, 429, {
      ok: false,
      reason: 'rate_limited',
      message: 'Too many searches. Please wait before trying again.'
    }, { ...rateHeaders, 'Retry-After': Math.max(1, rate.resetAt - Math.ceil(Date.now() / 1000)) });
  }

  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 503, {
      ok: false,
      configured: false,
      reason: 'missing_google_maps_api_key',
      message: 'GOOGLE_MAPS_API_KEY is not configured on the deployment.'
    }, rateHeaders);
  }

  const query = sanitizeQuery(req.body?.query, 180);
  const keyword = sanitizeQuery(req.body?.keyword, 180);
  const location = sanitizeQuery(req.body?.location, 120);
  const count = Math.max(1, Math.min(Number(req.body?.count || 12), 20));
  const regionCode = sanitizeQuery(req.body?.regionCode, 2).toUpperCase();
  const pageToken = sanitizeQuery(req.body?.pageToken, 1000);
  const textQuery = normalizePlacesQuery({ query, keyword, location });
  if (!textQuery) {
    return sendJson(res, 400, {
      ok: false,
      reason: 'missing_query',
      message: 'Enter a business, category, service, address, or natural-language Maps search.'
    }, rateHeaders);
  }

  const cacheKey = stableCacheKey({ textQuery: textQuery.toLowerCase(), count, regionCode, pageToken });
  const cached = await getCache(cacheKey);
  if (cached) return sendJson(res, 200, { ...cached, cached: true }, rateHeaders);

  const daily = await consumeDailyPlacesRequest();
  if (!daily.allowed) {
    return sendJson(res, 429, {
      ok: false,
      reason: 'daily_limit_reached',
      message: `The deployment reached its daily safety cap of ${PLACES_DAILY_LIMIT} Google Places requests.`
    }, rateHeaders);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
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
        message: data.error?.message || 'Google Places request failed.',
        details: data.error || data
      }, rateHeaders);
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
    await setCache(cacheKey, result);
    return sendJson(res, 200, result, rateHeaders);
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      configured: true,
      reason: error.name === 'AbortError' ? 'google_places_timeout' : 'connector_exception',
      message: error.name === 'AbortError' ? 'Google Places request timed out.' : error.message
    }, rateHeaders);
  } finally {
    clearTimeout(timeout);
  }
};
