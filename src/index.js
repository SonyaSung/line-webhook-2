const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();

const app = express();

const LINE_REPLY_API_URL = "https://api.line.me/v2/bot/message/reply";
const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const lineChannelSecret = process.env.LINE_CHANNEL_SECRET || "";
const suggestionCount = Number.parseInt(process.env.SUGGESTION_COUNT || "2", 10);
const resolveKeywords = (process.env.RESOLVE_KEYWORDS || "#定稿,#okok")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const dbPath = process.env.DB_PATH || "/data/line_assistant.sqlite";

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
  });
  return db;
}

const db = openDb();

function verifyLineSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(digest);
  if (sigA.length !== sigB.length) return false;
  return crypto.timingSafeEqual(sigA, sigB);
}

function insertResolvedCase(keyword, content, originalText, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO resolved_cases(keyword, content, original_text, user_id) VALUES(?, ?, ?, ?)",
      [keyword, content, originalText, userId || null],
      (err) => (err ? reject(err) : resolve())
    );
  });
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

async function handleLineEvent(event) {
  const replyToken = event.replyToken;
  if (!replyToken) return;

  const isTextMessage = event.type === "message" && event.message && event.message.type === "text";
  if (!isTextMessage) {
    await replyToLine(replyToken, [{ type: "text", text: "已收到" }]);
    return;
  }

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

app.get("/health", (req, res) => res.send("ok"));

app.post("/line/webhook", express.raw({ type: "*/*" }), async (req, res) => {
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
  for (const event of events) {
    try {
      await handleLineEvent(event);
    } catch (err) {
      console.error("Failed to process LINE event:", err);
    }
  }

  return res.status(200).send("ok");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
