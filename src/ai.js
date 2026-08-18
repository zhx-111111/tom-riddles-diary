// AI backends: the primary OpenAI-compatible chat model (default: Agnes
// 2.5 Flash on the .cn endpoint) and the backup vision model (default:
// Zhipu GLM-4.6V-Flash, free), with multi-key round-robin rotation to
// dodge provider rate limits (HTTP 429) and automatic fallback.

import { OCR_PROMPT } from "./prompts.js";

export class ChatError extends Error {
  constructor(status, detail) {
    super(`http ${status}: ${String(detail || "").slice(0, 300)}`);
    this.status = status;
    this.detail = String(detail || "").slice(0, 500);
  }
}

/// The endpoint refused the page image (it can read public URLs only, or is
/// text-only): the orchestrator answers by relaying through the backup
/// vision model as a scribe.
export class ImageError extends ChatError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Round-robin start index. With KV bound, a shared counter spreads traffic
/// across every key; without it, start at random.
async function nextIndex(env, label, n) {
  if (n <= 1) return 0;
  if (env.DIARY_KV) {
    try {
      const v = await env.DIARY_KV.get("kcount:" + label);
      const i = ((parseInt(v, 10) || 0) + 1) % n;
      await env.DIARY_KV.put("kcount:" + label, String(i));
      return i;
    } catch { /* fall through */ }
  }
  return Math.floor(Math.random() * n);
}

/// Read an OpenAI-style SSE stream, yielding content fragments only.
/// Thinking/reasoning deltas are ignored — the writer never sees the
/// model's inner voice.
async function* readSse(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const obj = JSON.parse(data);
        const delta = obj?.choices?.[0]?.delta;
        const frag = delta?.content;
        if (typeof frag === "string" && frag) yield frag;
      } catch { /* partial frame — skip */ }
    }
  }
}

/// Stream one chat completion. Tries each key in turn (round-robin start):
/// 429 / 5xx / network / bad-key errors rotate to the next key with a short
/// backoff. Yields content fragments; throws ChatError when every key fails,
/// or ImageError when the endpoint clearly refuses the image input.
export async function* streamChat(env, prov, messages, maxTokens) {
  const keys = prov.keys;
  if (!keys.length) throw new ChatError(0, "no api keys configured");
  const base = prov.base.replace(/\/+$/, "");
  const start = await nextIndex(env, prov.label, keys.length);
  let lastErr = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(start + attempt) % keys.length];
    const body = { model: prov.model, stream: true, max_tokens: maxTokens, messages };
    // No thinking process in the diary's hand — disable per-provider.
    if (prov.kind === "agnes") body.chat_template_kwargs = { enable_thinking: false };
    if (prov.kind === "zhipu") body.thinking = { type: "disabled" };

    let resp;
    try {
      resp = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = new ChatError(0, "network: " + (e?.message || e));
      await sleep(300);
      continue; // rotate key
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      lastErr = new ChatError(resp.status, detail);
      // Image input refused → let the orchestrator relay through the scribe.
      if (resp.status === 400 && /image|vision|multimodal|url|不支持|无效/i.test(detail)) {
        throw new ImageError(resp.status, detail);
      }
      // Rate-limited or upstream trouble → next key, gentle backoff.
      if (resp.status === 429 || resp.status >= 500 || resp.status === 401 || resp.status === 403) {
        await sleep(450 * (attempt + 1));
        continue;
      }
      throw lastErr; // other 4xx: configuration problem — surface it
    }

    yield* readSse(resp);
    return;
  }
  throw lastErr || new ChatError(0, "all keys exhausted");
}

/// Non-streaming single-shot completion (used for the scribe transcription).
async function completeOnce(env, prov, messages, maxTokens) {
  const keys = prov.keys;
  if (!keys.length) throw new ChatError(0, "no api keys configured");
  const base = prov.base.replace(/\/+$/, "");
  const start = await nextIndex(env, prov.label + ":once", keys.length);
  let lastErr = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(start + attempt) % keys.length];
    const body = { model: prov.model, stream: false, max_tokens: maxTokens, messages };
    if (prov.kind === "agnes") body.chat_template_kwargs = { enable_thinking: false };
    if (prov.kind === "zhipu") body.thinking = { type: "disabled" };
    try {
      const resp = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        lastErr = new ChatError(resp.status, await resp.text().catch(() => ""));
        if (resp.status === 429 || resp.status >= 500 || resp.status === 401 || resp.status === 403) {
          await sleep(450 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
      const obj = await resp.json();
      const text = obj?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return text.trim();
      lastErr = new ChatError(0, "empty completion");
    } catch (e) {
      if (e instanceof ChatError && e.status !== 0 && e.status !== 429 && e.status < 500 && e.status !== 401 && e.status !== 403) throw e;
      lastErr = e instanceof ChatError ? e : new ChatError(0, String(e?.message || e));
      await sleep(300);
    }
  }
  throw lastErr || new ChatError(0, "scribe failed");
}

/// The backup vision model reads the page and returns a verbatim transcript.
export function transcribeInk(env, prov, imageDataUrl) {
  return completeOnce(env, prov, [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: OCR_PROMPT },
      ],
    },
  ], 700);
}
