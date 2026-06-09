const {
  EU_COUNTRIES,
  META_API_VERSION,
  methodNotAllowed,
  normalizeCountry,
  rateLimit,
  sanitizeQuery,
  sendJson
} = require('../../lib/vercel-shared');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed(res);

  const rate = await rateLimit(req, 'meta', 30, 60);
  if (!rate.allowed) {
    return sendJson(res, 429, { ok: false, reason: 'rate_limited', message: 'Too many Meta verification requests.' });
  }

  const name = sanitizeQuery(req.body?.name || req.query?.name, 120);
  const country = normalizeCountry(req.body?.country || req.query?.country || 'AU');
  const token = String(process.env.META_ACCESS_TOKEN || '').trim();
  const limit = Math.max(1, Math.min(Number(req.body?.limit || req.query?.limit || 8), 25));

  if (!name) return sendJson(res, 400, { ok: false, verified: false, reason: 'missing_name' });
  const publicUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${encodeURIComponent(country)}&q=${encodeURIComponent(name)}`;
  if (!token) {
    return sendJson(res, 200, {
      ok: false,
      verified: false,
      configured: false,
      source: 'meta_ad_library_api',
      reason: 'missing_meta_access_token',
      message: 'META_ACCESS_TOKEN is not configured on the deployment.',
      publicUrl
    });
  }

  const adType = EU_COUNTRIES.has(country) ? 'ALL' : 'POLITICAL_AND_ISSUE_ADS';
  const api = new URL(`https://graph.facebook.com/${META_API_VERSION}/ads_archive`);
  api.searchParams.set('search_terms', name);
  api.searchParams.set('ad_reached_countries', JSON.stringify([country]));
  api.searchParams.set('ad_type', adType);
  api.searchParams.set('limit', String(limit));
  api.searchParams.set('fields', 'id,page_id,page_name,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,publisher_platforms');
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
        publicUrl
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
        : 'Outside UK/EU, API coverage is mainly social issue, election, and political ads.'
    });
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      verified: false,
      configured: true,
      source: 'meta_ad_library_api',
      reason: 'connector_exception',
      message: error.message,
      publicUrl
    });
  }
};
