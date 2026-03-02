# line-webhook-2

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
```bash
set LINE_CHANNEL_ACCESS_TOKEN=YOUR_LINE_CHANNEL_ACCESS_TOKEN
set LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET
set TZ=Asia/Taipei
set SUGGESTION_COUNT=2
set RESOLVE_KEYWORDS=#定稿,#okok
set DB_PATH=/data/line_assistant.sqlite
set OCR_ENABLED=true
set OCR_MAX_IMAGES_PER_DAY=100
set ALLOWED_USER_IDS=Uxxxxxxxx1,Uxxxxxxxx2
set GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account",...}
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

## Google Vision OCR Setup

1. Create a Google Cloud project and enable **Vision API**.
2. Create a Service Account with Vision access.
3. Generate a JSON key for that Service Account.
4. Put the JSON content into `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
5. Set `OCR_ENABLED=true`.
6. Set `ALLOWED_USER_IDS` to specific LINE user IDs to control OCR cost.
7. Optional daily cap: `OCR_MAX_IMAGES_PER_DAY` (default `100`).

## Behavior Summary

- `POST /line/webhook` validates `x-line-signature`.
- Text `#待回 ...`: replies with multiple separate suggestions.
- Text `#定稿 ...` / `#okok ...`: marks case resolved and writes to sqlite.
- Image message:
  - Downloads image from LINE content API by `message.id`.
  - Runs OCR via Google Vision.
  - Uses OCR text as `#待回` content and replies suggestions.
  - If OCR fails: replies `我讀不到圖片文字，請補一張更清楚的圖或直接貼文字`.
- OCR only runs when sender is in `ALLOWED_USER_IDS`.
- Non-text or non-keyword messages reply `已收到`.
- Reply API errors are logged; webhook still returns `200 ok`.

## Debug Logs For OCR

- Startup logs print:
  - `APP_VERSION`
  - `OCR_ENABLED` raw value and parsed boolean
  - `OCR_MAX_IMAGES_PER_DAY`
  - `ALLOWED_USER_IDS` count only
  - `SUGGESTION_COUNT`
  - `DB_PATH`
- Event logs print:
  - `event.type`
  - `message.type`
  - whether `source.userId` exists
  - `isAllowedUser`
  - matched flow branch
- OCR image logs print:
  - image branch entered
  - LINE content download start/success/fail with status
  - downloaded image byte size
  - vision client init success/fail
  - OCR success text length or empty result
  - quota check result (`todayCount`, `max`, `allowed`)
  - final response branch (`2 suggestions` or fallback)
