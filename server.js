const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8765);
const HOST = '127.0.0.1';
const APP_FILE = process.env.LEADSCOUT_HTML || 'C:\\Users\\acer\\Downloads\\leadscout_v3.html';
const META_API_VERSION = process.env.META_API_VERSION || 'v25.0';

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
        metaApiVersion: META_API_VERSION
      });
    }

    if (url.pathname === '/api/meta-ads/search') {
      return await handleMetaAds(req, res, url);
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
