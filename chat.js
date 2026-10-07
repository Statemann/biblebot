import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, TRADITIONS, DEFAULT_TRADITION } from "../lib/prompt.js";

export const config = { maxDuration: 60 }; // allow slower answers; replaces vercel.json

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT || 20);
const TRANSLATIONS = ["web", "kjv", "asv", "webbe"]; // public-domain, quotable
const MAX_MSGS = 12;
const MAX_USER_CHARS = 2000;
const MAX_ASSISTANT_CHARS = 6000;
const MAX_TOOL_ROUNDS = 4;

const BIBLE_TOOL = {
  name: "get_passage",
  description:
    "Fetch the exact text of a Bible passage from a public-domain translation. Always call this before quoting scripture. One call per passage.",
  input_schema: {
    type: "object",
    properties: {
      reference: { type: "string", description: "e.g. 'John 3:16', 'Romans 8:28-30', '1 Cor 13'" },
      translation: { type: "string", enum: TRANSLATIONS },
    },
    required: ["reference"],
  },
};

// Best-effort per-IP limiter (memory is per warm serverless instance).
const hits = new Map();
function isLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { n: 1, reset: now + 3_600_000 });
    return false;
  }
  h.n += 1;
  return h.n > HOURLY_LIMIT;
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS),
    }))
    .slice(-MAX_MSGS);
  while (out.length && out[0].role !== "user") out.shift();
  const merged = []; // enforce strict user/assistant alternation
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else merged.push({ ...m });
  }
  if (!merged.length || merged[merged.length - 1].role !== "user") return null;
  return merged;
}

async function fetchPassage(reference, translation) {
  const tr = TRANSLATIONS.includes(translation) ? translation : "web";
  try {
    const ref = encodeURI(String(reference).trim()).replace(/%20/g, "+");
    const r = await fetch(`https://bible-api.com/${ref}?translation=${tr}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return `Could not retrieve '${reference}'. Do not quote it from memory; tell the user the exact text was unavailable.`;
    }
    const d = await r.json();
    return `${d.reference} (${d.translation_name || tr})\n${String(d.text).trim().slice(0, 6000)}`;
  } catch {
    return "Passage lookup failed. Paraphrase only and say the exact text was unavailable.";
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) {
    return res.status(401).json({ error: "Access code required" });
  }
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString().split(",")[0].trim();
  if (isLimited(ip)) {
    return res.status(429).json({ error: "You've asked a lot of questions this hour. Please come back a little later." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const messages = cleanMessages(body?.messages);
  if (!messages) return res.status(400).json({ error: "Invalid request" });
  const tradition = Object.hasOwn(TRADITIONS, body.tradition) ? body.tradition : DEFAULT_TRADITION;
  const translation = TRANSLATIONS.includes(body.translation) ? body.translation : "web";
  const system = buildSystemPrompt(tradition, translation);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const convo = [...messages];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1500,
        system,
        tools: [BIBLE_TOOL],
        messages: convo,
      });
      stream.on("text", (t) => send({ t }));
      const final = await stream.finalMessage();

      if (final.stop_reason !== "tool_use") {
        send({ done: true });
        return res.end();
      }
      convo.push({ role: "assistant", content: final.content });
      const results = [];
      for (const block of final.content) {
        if (block.type !== "tool_use") continue;
        send({ status: `Looking up ${String(block.input?.reference || "the passage").slice(0, 40)}…` });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: await fetchPassage(block.input?.reference || "", block.input?.translation || translation),
        });
      }
      convo.push({ role: "user", content: results });
    }
    send({ t: "\n\nI had trouble gathering the passages for that one. Please try again, perhaps with a specific verse or topic." });
    send({ done: true });
    res.end();
  } catch (err) {
    console.error("chat error", err?.status, err?.message);
    send({ error: "The assistant is unavailable right now. Please try again in a moment." });
    res.end();
  }
}
