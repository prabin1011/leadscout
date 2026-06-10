const dns = require('dns').promises;
const net = require('net');
const { methodNotAllowed, rateLimit, sendJson } = require('../../lib/vercel-shared');

const MAX_HTML_BYTES = 750000;

function isPrivateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0;
  }
  const value = address.toLowerCase();
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagContent(html, tag) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeHtml(match ? match[1].replace(/<[^>]+>/g, ' ') : '');
}

function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    if (!name || name[1].toLowerCase() !== key.toLowerCase()) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (content) return decodeHtml(content[1]);
  }
  return '';
}

function extractHeadings(html, tag, limit) {
  const matches = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')) || [];
  return matches.slice(0, limit).map(value => decodeHtml(value.replace(/<[^>]+>/g, ' '))).filter(Boolean);
}

async function assertPublicUrl(target) {
  const addresses = await dns.lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('private_address');
  }
}

async function fetchPublicHtml(initialUrl, signal) {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'LeadScoutWebsiteAudit/1.0',
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current);
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || current.port) {
      throw new Error('invalid_redirect');
    }
  }
  throw new Error('too_many_redirects');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const rate = await rateLimit(req, 'website-audit', 20, 60);
  if (!rate.allowed) {
    return sendJson(res, 429, { ok: false, reason: 'rate_limited', message: 'Too many website audit requests.' });
  }

  let target;
  try {
    target = new URL(String(req.body?.url || '').trim());
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('unsupported_protocol');
    if (target.username || target.password || target.port) throw new Error('unsupported_url');
  } catch {
    return sendJson(res, 400, { ok: false, reason: 'invalid_url', message: 'A public HTTP or HTTPS website URL is required.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchPublicHtml(target, controller.signal);

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('text/html')) {
      return sendJson(res, 422, {
        ok: false,
        reason: 'website_unavailable',
        message: `Website returned ${response.status} or non-HTML content.`
      });
    }

    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    return sendJson(res, 200, {
      ok: true,
      source: 'public_website_metadata',
      url: response.url,
      title: tagContent(html, 'title'),
      description: metaContent(html, 'description'),
      ogTitle: metaContent(html, 'og:title'),
      ogDescription: metaContent(html, 'og:description'),
      ogImage: metaContent(html, 'og:image'),
      themeColor: metaContent(html, 'theme-color'),
      language: (html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i) || [])[1] || '',
      h1: extractHeadings(html, 'h1', 4),
      h2: extractHeadings(html, 'h2', 8),
      hasViewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html),
      hasSchema: /application\/ld\+json/i.test(html),
      hasBookingLanguage: /\b(book|appointment|reserve|schedule|consultation)\b/i.test(html),
      hasContactForm: /<form\b/i.test(html),
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error.message === 'private_address') {
      return sendJson(res, 400, { ok: false, reason: 'private_address', message: 'Only public websites can be audited.' });
    }
    return sendJson(res, 502, {
      ok: false,
      reason: error.name === 'AbortError' ? 'website_timeout' : 'website_audit_failed',
      message: error.name === 'AbortError' ? 'Website audit timed out.' : error.message
    });
  } finally {
    clearTimeout(timeout);
  }
};
