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
const appVersion = process.env.APP_VERSION || process.env.npm_package_version || "dev";
const suggestionCount = Number.parseInt(process.env.SUGGESTION_COUNT || "2", 10);
const resolveKeywords = (process.env.RESOLVE_KEYWORDS || "#定稿,#okok")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const dbPath = process.env.DB_PATH || "/data/line_assistant.sqlite";
const ocrEnabledRaw = process.env.OCR_ENABLED || "";
const ocrMaxImagesPerDay = Number.parseInt(process.env.OCR_MAX_IMAGES_PER_DAY || "100", 10);
const allowedUserIdsRaw = process.env.ALLOWED_USER_IDS || "";
const googleCredentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "";

function parseBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function normalizeUserIdToken(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
}

function parseAllowedUserIds(raw) {
  if (!raw || !String(raw).trim()) return [];

  const input = String(raw).trim();
  let parsedValues = [];

  if (input.startsWith("[") && input.endsWith("]")) {
    try {
      const fromJson = JSON.parse(input);
      parsedValues = Array.isArray(fromJson) ? fromJson : [input];
    } catch (err) {
      parsedValues = input.split(",");
    }
  } else {
    parsedValues = input.split(",");
  }

  return Array.from(new Set(parsedValues.map((x) => normalizeUserIdToken(x)).filter(Boolean)));
}

function maskUserId(value) {
  if (!value) return "(none)";
  const normalized = String(value).trim();
  return `${normalized.slice(0, 8)}...`;
}

function formatError(err) {
  if (!err) return "unknown error";
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack).split("\n").slice(0, 4).join(" | ") : "";
  return stack ? `${message} | ${stack}` : message;
}

const ocrEnabled = parseBoolean(ocrEnabledRaw);
const allowedUserIds = parseAllowedUserIds(allowedUserIdsRaw);
const allowedUserIdSet = new Set(allowedUserIds);

function openDb() {
  const dbDir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.error("[db] Failed to create DB directory:", dbDir, formatError(err));
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

  if (current >= max) return { allowed: false, current, max, dateKey };

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
  return { allowed: true, current: current + 1, max, dateKey };
}

let visionClient = null;
let visionClientInitOk = false;

function initVisionClient() {
  if (!ocrEnabled) return;
  try {
    if (googleCredentialsJson) {
      const credentials = JSON.parse(googleCredentialsJson);
      visionClient = new vision.ImageAnnotatorClient({ credentials });
    } else {
      visionClient = new vision.ImageAnnotatorClient();
    }
    visionClientInitOk = true;
  } catch (err) {
    visionClient = null;
    visionClientInitOk = false;
    console.error("[ocr] vision client init fail:", formatError(err));
  }
}

initVisionClient();

console.log(
  `[startup] APP_VERSION=${appVersion} OCR_ENABLED_RAW=${ocrEnabledRaw || "(empty)"} OCR_ENABLED=${ocrEnabled} OCR_MAX_IMAGES_PER_DAY=${ocrMaxImagesPerDay} ALLOWED_USER_IDS_COUNT=${allowedUserIds.length} SUGGESTION_COUNT=${suggestionCount} DB_PATH=${dbPath}`
);
console.log(`[startup] vision client init ${visionClientInitOk ? "success" : "fail"}`);

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

function parsePendingContent(text) {
  const match = text.match(/^[#＃]待回(?:\s+|[:：]\s*)?(.*)$/u);
  return match ? match[1].trim() : null;
}

function buildWaitReplySuggestions(content, count) {
  const trimmed = (content || "").trim();
  const safeCount = Number.isFinite(count) && count > 0 ? count : 2;
  const defaults = [
    trimmed ? `收到，我會照這個方向處理：${trimmed}` : "收到，我先幫你整理重點，稍後回你。",
    trimmed ? `了解，我先這樣回覆對方：${trimmed}` : "了解，這件事我先接手處理，晚點給你進度。",
    "好的，我已經記下來，會直接幫你跟進。",
  ];
  return defaults.slice(0, safeCount);
}

function generateAssistantReply({ userText, imageOcrText }) {
  if (imageOcrText && imageOcrText.trim()) {
    return `我已看過圖片內容，重點如下：\n${imageOcrText.slice(0, 300)}\n\n如果你要，我可以再幫你整理成可直接傳給對方的一段訊息。`;
  }
  if (userText && userText.trim()) {
    return `收到，我理解你的重點是：${userText.trim()}\n\n如果你願意，我可以直接幫你整理成一版可傳送的回覆。`;
  }
  return "我已收到你的訊息，請再補充你希望我怎麼協助。";
}

async function replyToLine(replyToken, messages) {
  if (!lineChannelAccessToken) {
    console.error("[line-reply] LINE_CHANNEL_ACCESS_TOKEN missing");
    return false;
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
      console.error(`[line-reply] failed status=${resp.status} body=${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[line-reply] error:", formatError(err));
    return false;
  }
}

function createFinalReplySender(replyToken) {
  let replied = false;
  return {
    hasReplied() {
      return replied;
    },
    async sendFinalReply(payload) {
      if (replied) {
        console.error("[reply] duplicate reply blocked");
        return false;
      }

      const texts = Array.isArray(payload) ? payload : [payload];
      const cleanTexts = texts.map((x) => String(x || "").trim()).filter(Boolean);
      if (cleanTexts.length === 0) return false;

      const len = cleanTexts.join("\n").length;
      console.log(`[reply] mode=final len=${len}`);
      const ok = await replyToLine(
        replyToken,
        cleanTexts.map((text) => ({ type: "text", text }))
      );
      if (ok) replied = true;
      return ok;
    },
  };
}

async function downloadLineImage(messageId) {
  if (!lineChannelAccessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN missing");
  }
  console.log(`[ocr] LINE content download start messageId=${messageId}`);
  const resp = await fetch(`${LINE_CONTENT_API_BASE}/${messageId}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${lineChannelAccessToken}`,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[ocr] LINE content download fail status=${resp.status}`);
    throw new Error(`LINE content API failed status=${resp.status} body=${body}`);
  }

  console.log(`[ocr] LINE content download success status=${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`[ocr] downloaded image bytes=${buffer.length}`);
  return buffer;
}

async function runOcr(imageBuffer) {
  if (!visionClient) throw new Error("Google Vision client not initialized");
  const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
  const text = result && result.fullTextAnnotation && result.fullTextAnnotation.text;
  if (!text || !text.trim()) {
    console.log("[ocr] OCR empty text");
    throw new Error("No OCR text extracted");
  }
  console.log(`[ocr] OCR success textLength=${text.trim().length}`);
  return text.trim();
}

function isAllowedOcrUser(event) {
  const userId = event && event.source && event.source.userId;
  return Boolean(userId && allowedUserIdSet.has(userId));
}

async function handleTextMessage(event, replySender) {
  const text = (event.message && event.message.text ? event.message.text : "").trim();
  if (!text) {
    await replySender.sendFinalReply("我已收到你的訊息，請再補充你希望我怎麼協助。");
    return "text:empty";
  }

  const pendingContent = parsePendingContent(text);
  if (pendingContent !== null) {
    await replySender.sendFinalReply(buildWaitReplySuggestions(pendingContent, suggestionCount));
    return "text:#待回";
  }

  const matchedResolveKeyword = resolveKeywords.find((kw) => text.startsWith(kw));
  if (matchedResolveKeyword) {
    const content = text.slice(matchedResolveKeyword.length).trim();
    try {
      await insertResolvedCase(matchedResolveKeyword, content, text, event.source && event.source.userId);
      await replySender.sendFinalReply("已收到，這案我已標記完成。");
    } catch (err) {
      console.error("[db] Failed to write resolved case:", formatError(err));
      await replySender.sendFinalReply("我已收到，但寫入案件狀態時發生問題，請稍後再試一次。");
    }
    return `text:resolve:${matchedResolveKeyword}`;
  }

  const assistantText = generateAssistantReply({ userText: text });
  await replySender.sendFinalReply(assistantText);
  return "text:assistant";
}

async function handleImageMessage(event, replySender) {
  console.log("[flow] entered image branch");
  console.log(`[ocr] vision client init ${visionClientInitOk ? "success" : "fail"}`);

  let ocrText = "";

  if (ocrEnabled && isAllowedOcrUser(event)) {
    try {
      const quota = await tryConsumeOcrQuota();
      console.log(
        `[ocr] quota check result todayCount=${quota.current} max=${quota.max} allowed=${quota.allowed}`
      );

      if (quota.allowed) {
        const messageId = event.message && event.message.id;
        if (!messageId) throw new Error("Missing image message.id");
        const imageBuffer = await downloadLineImage(messageId);
        ocrText = await runOcr(imageBuffer);
      } else {
        console.log("[ocr] quota exceeded");
      }
    } catch (err) {
      console.error("[ocr] image flow failed:", formatError(err));
    }
  } else {
    console.log("[ocr] skipped (disabled or not allowed user)");
  }

  if (ocrText) {
    const assistantText = generateAssistantReply({ imageOcrText: ocrText });
    await replySender.sendFinalReply(assistantText);
    return "image:assistant";
  }

  await replySender.sendFinalReply("我看到了圖片，但目前無法完整辨識，請補充你想問的重點。");
  return "image:fallback";
}

async function handleLineEvent(event) {
  const replyToken = event.replyToken;
  const eventId = event.webhookEventId || `${event.timestamp || Date.now()}-${(replyToken || "").slice(0, 8)}`;
  if (!replyToken) {
    console.log(`[flow] eventId=${eventId} type=${event.type || "unknown"} branch=no-reply-token replied=false`);
    return;
  }

  const hasUserId = Boolean(event && event.source && event.source.userId);
  const incomingUserId = hasUserId ? event.source.userId : "";
  const allowed = isAllowedOcrUser(event);
  const allowedMaskedList = allowedUserIds.map((id) => maskUserId(id));
  const incomingUserIdMasked = maskUserId(incomingUserId);
  console.log(
    `[AUTH] incoming=${incomingUserIdMasked} allowed=[${allowedMaskedList.join(",")}] hasUserId=${hasUserId} isAllowedUser=${allowed}`
  );

  const messageType = event && event.message && event.message.type ? event.message.type : "";
  const replySender = createFinalReplySender(replyToken);
  let branch = "fallback";

  try {
    if (!(event.type === "message" && event.message)) {
      await replySender.sendFinalReply("已收到。");
      branch = "non-message:fallback";
    } else if (messageType === "text") {
      branch = await handleTextMessage(event, replySender);
    } else if (messageType === "image") {
      branch = await handleImageMessage(event, replySender);
    } else {
      await replySender.sendFinalReply("已收到。");
      branch = `message:${messageType || "unknown"}:fallback`;
    }
  } catch (err) {
    console.error("[event] process failed:", formatError(err));
    if (!replySender.hasReplied()) {
      await replySender.sendFinalReply("目前系統忙碌中，請稍後再試。");
    }
    branch = `${branch}:error`;
  }

  const typeLabel = messageType || event.type || "unknown";
  console.log(`[flow] eventId=${eventId} type=${typeLabel} branch=${branch} replied=${replySender.hasReplied()}`);
}

app.get("/health", (req, res) => res.send("ok"));

app.post("/line/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.get("x-line-signature");
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    console.error("[webhook] body is not raw buffer");
    return res.status(400).send("bad request");
  }

  if (!verifyLineSignature(rawBody, signature, lineChannelSecret)) {
    console.error("[webhook] invalid LINE signature");
    return res.status(401).send("invalid signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("[webhook] invalid JSON payload:", formatError(err));
    return res.status(200).send("ok");
  }

  const events = Array.isArray(body.events) ? body.events : [];
  res.status(200).send("ok");
  console.log(`[webhook] ack events=${events.length}`);

  setImmediate(async () => {
    for (const event of events) {
      await handleLineEvent(event);
    }
  });

  return undefined;
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
