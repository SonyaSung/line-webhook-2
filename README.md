# line-webhook-2

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Set env vars:
```bash
set LINE_CHANNEL_ACCESS_TOKEN=YOUR_LINE_CHANNEL_ACCESS_TOKEN
set LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET
set TZ=Asia/Taipei
set SUGGESTION_COUNT=2
set RESOLVE_KEYWORDS=#定稿,#okok
set DB_PATH=/data/line_assistant.sqlite
```

3. Start server:
```bash
npm start
```

4. Health check:
```bash
curl http://localhost:3000/health
```
Expected response: `ok`

## Behavior

- `POST /line/webhook` validates `x-line-signature`.
- `#待回 ...` replies multiple separate messages (default 2).
- `#定稿 ...` or `#okok ...` marks case as resolved in sqlite.
- Non-text or non-keyword messages reply `已收到`.
- Reply API failure logs error but webhook still returns `200 ok`.
