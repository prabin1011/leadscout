# LeadScout

LeadScout is a single-page market intelligence prototype with local Node and Vercel serverless backends.

## Vercel Deployment

Connect the private GitHub repository to Vercel. The included `vercel.json` serves `leadscout_v3.html` at `/`, while `/api/*` runs as serverless functions.

Add these variables in **Vercel Project Settings > Environment Variables** for Production, Preview, and Development as appropriate.

### Required

| Variable | Purpose |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Real Google Places API (New) Text Search |
| `ANTHROPIC_API_KEY` | Outreach, campaign and website generation |

### Optional

| Variable | Default | Purpose |
| --- | --- | --- |
| `META_ACCESS_TOKEN` | none | Meta Ad Library API verification where coverage permits |
| `META_API_VERSION` | `v25.0` | Meta Graph API version |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Anthropic model used by server-side generation |
| `PLACES_RATE_LIMIT` | `10` | Places searches per IP per minute |
| `PLACES_DAILY_LIMIT` | `250` | Deployment-wide Places safety cap |
| `PLACES_CACHE_MS` | `900000` | Places cache duration in milliseconds |

### Recommended For Production

Create an Upstash Redis database through Vercel Marketplace or Upstash and add:

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Persistent cache/rate-limit REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Persistent cache/rate-limit token |

Without Upstash, caching and counters are best-effort per warm serverless instance. Google Cloud quotas remain the final billing protection.

After changing variables, redeploy the latest Vercel deployment.

### Google Key Setup

1. Rotate the Google key previously pasted into chat.
2. Enable billing and **Places API (New)**.
3. Restrict the key to **Places API (New)**.
4. For a stable deployed server IP, add IP restrictions where your hosting setup supports them.
5. Configure Google Cloud API quotas and budget alerts.

## Run Without API Tokens

```powershell
$node='C:\Users\acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node C:\Users\acer\Documents\Leadscout\server.js
```

Open:

`http://127.0.0.1:8765/leadscout_v3.html`

Meta ads will be labeled as estimated because no API token is configured.
Google business search will remain disabled rather than returning dummy companies.

## Run With Google Places API

Enable **Places API (New)** and billing in Google Cloud, then start the server with a restricted server-side key:

```powershell
$env:GOOGLE_MAPS_API_KEY='your-restricted-server-key'
$node='C:\Users\acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node C:\Users\acer\Documents\Leadscout\server.js
```

The key is only sent from `server.js` to Google. It is never included in the browser HTML.

Default local safeguards:

- 10 searches per IP per minute
- 250 Google Places requests per day
- 20 results per search
- 15-minute cache for identical queries

Override these with `PLACES_RATE_LIMIT`, `PLACES_DAILY_LIMIT`, and `PLACES_CACHE_MS`.

Also configure Google Cloud quotas and restrict the key to **Places API (New)**. For a deployed server, add an IP-address application restriction.

## Run With Meta Ad Library API

```powershell
$env:META_ACCESS_TOKEN='your-meta-access-token'
$node='C:\Users\acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node C:\Users\acer\Documents\Leadscout\server.js
```

The app calls:

`/api/meta-ads/search`

Verified Meta results are only shown when the backend receives a successful Meta Ad Library API response. If the token is missing, expired, or the market/category is outside API coverage, the UI keeps the data labeled as estimated and links to the public Ad Library for manual verification.

## Run With Anthropic

```powershell
$env:ANTHROPIC_API_KEY='your-anthropic-key'
$env:ANTHROPIC_MODEL='claude-sonnet-4-6'
```

Anthropic calls go through `/api/anthropic/messages`; the browser never receives the API key.
