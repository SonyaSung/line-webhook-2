const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const vision = require("@google-cloud/vision");

const app = express();

const LINE_REPLY_API_URL = "https://api.line.me/v2/bot/message/reply";
const LINE_CONTENT_API_BASE = "https://api-data.line.me/v2/bot/message";

const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const lineChannelSecret = process.env.LINE_CHANNEL_SECRET || "";
const timezone = process.env.TZ || "UTC";
const suggestionCount = Number.parseInt(process.env.SUGGESTION_COUNT || "2", 10);
const resolveKeywords = (process.env.RESOLVE_KEYWORDS || "#定稿,#okok")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const dbPath = process.env.DB_PATH || "/data/line_assistant.sqlite";
const ocrEnabled = String(process.env.OCR_ENABLED || "").toLowerCase() === "true";
const ocrMaxImagesPerDay = Number.parseInt(process.env.OCR_MAX_IMAGES_PER_DAY || "100", 10);
const allowedUserIds = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);
const googleCredentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "";

function openDb() {
  const dbDir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create DB directory:", dbDir, err);
  }

  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS resolved_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword TEXT NOT NULL,
        content TEXT,
        original_text TEXT NOT NULL,
        user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS ocr_daily_usage (
        date_key TEXT PRIMARY KEY,
        image_count INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  return db;
}

const db = openDb();

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getDateKeyForTz() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function tryConsumeOcrQuota() {
  const dateKey = getDateKeyForTz();
  const row = await dbGet("SELECT image_count FROM ocr_daily_usage WHERE date_key = ?", [dateKey]);
  const current = row ? Number(row.image_count) : 0;
  const max = Number.isFinite(ocrMaxImagesPerDay) && ocrMaxImagesPerDay > 0 ? ocrMaxImagesPerDay : 100;
  if (current >= max) return false;

  await dbRun(
    `
    INSERT INTO ocr_daily_usage(date_key, image_count, updated_at)
    VALUES(?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(date_key) DO UPDATE SET
      image_count = image_count + 1,
      updated_at = CURRENT_TIMESTAMP
    `,
    [dateKey]
  );
  return true;
}

function initVisionClient() {
  if (!ocrEnabled) return null;
  try {
    if (googleCredentialsJson) {
      const credentials = JSON.parse(googleCredentialsJson);
      return new vision.ImageAnnotatorClient({ credentials });
    }
    return new vision.ImageAnnotatorClient();
  } catch (err) {
    console.error("Failed to init Google Vision client:", err);
    return null;
  }
}

const visionClient = initVisionClient();

function verifyLineSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(digest);
  if (sigA.length !== sigB.length) return false;
  return crypto.timingSafeEqual(sigA, sigB);
}

function insertResolvedCase(keyword, content, originalText, userId) {
  return dbRun(
    "INSERT INTO resolved_cases(keyword, content, original_text, user_id) VALUES(?, ?, ?, ?)",
    [keyword, content, originalText, userId || null]
  );
}

function buildWaitReplySuggestions(content, count) {
  const trimmed = (content || "").trim();
  const safeCount = Number.isFinite(count) && count > 0 ? count : 2;
  const defaults = [
    trimmed
      ? `收到，我會照這個方向處理：${trimmed}`
      : "收到，我先幫你整理重點，稍後回你。",
    trimmed
      ? `了解，我先這樣回覆對方：${trimmed}`
      : "了解，這件事我先接手處理，晚點給你進度。",
    "好的，我已經記下來，會直接幫你跟進。",
  ];
  return defaults.slice(0, safeCount).map((text) => ({ type: "text", text }));
}

async function replyToLine(replyToken, messages) {
  if (!lineChannelAccessToken) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN is missing.");
    return;
  }
  try {
    const resp = await fetch(LINE_REPLY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lineChannelAccessToken}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error("LINE Reply API failed:", resp.status, body);
    }
  } catch (err) {
    console.error("LINE Reply API error:", err);
  }
}

async function downloadLineImage(messageId) {
  if (!lineChannelAccessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");
  }

  const resp = await fetch(`${LINE_CONTENT_API_BASE}/${messageId}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${lineChannelAccessToken}`,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LINE content API failed: ${resp.status} ${body}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function runOcr(imageBuffer) {
  if (!visionClient) {
    throw new Error("Google Vision client is not initialized");
  }
  const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
  const text = result && result.fullTextAnnotation && result.fullTextAnnotation.text;
  if (!text || !text.trim()) {
    throw new Error("No OCR text extracted");
  }
  return text.trim();
}

function isAllowedOcrUser(event) {
  const userId = event && event.source && event.source.userId;
  if (!userId) return false;
  return allowedUserIds.has(userId);
}

async function handleImageMessage(event, replyToken) {
  if (!ocrEnabled || !isAllowedOcrUser(event)) {
    await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
    return;
  }

  try {
    const canUse = await tryConsumeOcrQuota();
    if (!canUse) {
      console.error("OCR quota exceeded for today.");
      await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
      return;
    }

    const messageId = event.message && event.message.id;
    if (!messageId) throw new Error("Missing image message.id");

    const imageBuffer = await downloadLineImage(messageId);
    const ocrText = await runOcr(imageBuffer);
    const messages = buildWaitReplySuggestions(ocrText, suggestionCount);
    await replyToLine(replyToken, messages);
  } catch (err) {
    console.error("OCR flow failed:", err);
    await replyToLine(replyToken, [
      { type: "text", text: "我讀不到圖片文字，請補一張更清楚的圖或直接貼文字" },
    ]);
  }
}

async function handleTextMessage(event, replyToken) {
  const text = (event.message.text || "").trim();
  if (!text) {
    await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
    return;
  }

  if (text.startsWith("#待回")) {
    const content = text.replace(/^#待回\s*/, "");
    const messages = buildWaitReplySuggestions(content, suggestionCount);
    await replyToLine(replyToken, messages);
    return;
  }

  const matchedResolveKeyword = resolveKeywords.find((kw) => text.startsWith(kw));
  if (matchedResolveKeyword) {
    const content = text.slice(matchedResolveKeyword.length).trim();
    try {
      await insertResolvedCase(matchedResolveKeyword, content, text, event.source && event.source.userId);
      await replyToLine(replyToken, [{ type: "text", text: "已收到，這案我已標記完成。" }]);
    } catch (err) {
      console.error("Failed to write resolved case:", err);
      await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
    }
    return;
  }

  await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
}

async function handleLineEvent(event) {
  const replyToken = event.replyToken;
  if (!replyToken) return;

  const message = event.message;
  const isMessageEvent = event.type === "message" && message;
  if (!isMessageEvent) {
    await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
    return;
  }

  if (message.type === "text") {
    await handleTextMessage(event, replyToken);
    return;
  }

  if (message.type === "image") {
    await handleImageMessage(event, replyToken);
    return;
  }

  await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
}

app.get("/health", (req, res) => res.send("ok"));

app.post("/line/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.get("x-line-signature");
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    console.error("Webhook body is not raw buffer.");
    return res.status(400).send("bad request");
  }

  if (!verifyLineSignature(rawBody, signature, lineChannelSecret)) {
    console.error("Invalid LINE webhook signature.");
    return res.status(401).send("invalid signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("Invalid JSON payload:", err);
    return res.status(200).send("ok");
  }

  const events = Array.isArray(body.events) ? body.events : [];
  res.status(200).send("ok");

  setImmediate(async () => {
    for (const event of events) {
      try {
        await handleLineEvent(event);
      } catch (err) {
        console.error("Failed to process LINE event:", err);
      }
    }
  });

  return undefined;
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
