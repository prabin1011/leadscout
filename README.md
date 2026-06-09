# LeadScout Local Preview

This workspace now includes a small backend wrapper for the single-file app at:

`C:\Users\acer\Downloads\leadscout_v3.html`

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
