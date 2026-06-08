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

## Run With Meta Ad Library API

```powershell
$env:META_ACCESS_TOKEN='your-meta-access-token'
$node='C:\Users\acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node C:\Users\acer\Documents\Leadscout\server.js
```

The app calls:

`/api/meta-ads/search`

Verified Meta results are only shown when the backend receives a successful Meta Ad Library API response. If the token is missing, expired, or the market/category is outside API coverage, the UI keeps the data labeled as estimated and links to the public Ad Library for manual verification.
