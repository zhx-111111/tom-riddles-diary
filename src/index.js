// Tom Riddle's Diary — Cloudflare Worker.
//
// Routes:
//   GET  /                 diary front end
//   GET  /admin            admin panel (Chinese, password protected)
//   POST /api/login        password → 12h token
//   GET  /api/config       public front-end config
//   POST /api/chat         one page turn (SSE stream back)
//   POST /api/recall       fetch one remembered page for conjuring
//   GET  /api/admin/state  admin state (token)
//   POST /api/admin/config save overrides (token)
//   POST /api/admin/forget erase memories (token)
//   POST /api/admin/footer save footer HTML + file (token)
//   POST /api/admin/guide  save guide HTML (token)

import { PERSONA, MEMORY_PROTOCOL } from "./prompts.js";
import { StreamParser, clean } from "./parser.js";
import {
  DEFAULT_ADMIN_PASSWORD, DEFAULT_CONFIG, BUILTIN_THEMES,
  loadConfig, mergeConfig, oneLine, spokenDate, splitKeys, publicConfig,
} from "./config.js";
import { ChatError, ImageError, streamChat, transcribeInk } from "./ai.js";

// ---------------------------------------------------------------- utilities

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

function providers(env) {
  return {
    primary: {
      label: "primary", kind: "agnes",
      base: env.AGNES_BASE_URL || "https://apihub.agnes-ai.cn/v1",
      model: env.AGNES_MODEL || "agnes-2.5-flash",
      keys: splitKeys(env.AGNES_API_KEYS),
    },
    zhipu: {
      label: "zhipu", kind: "zhipu",
      base: env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
      model: env.ZHIPU_MODEL || "glm-4.6v-flash",
      keys: splitKeys(env.ZHIPU_API_KEYS),
    },
  };
}

function tzOffset(env) {
  const v = Number(env.TZ_OFFSET);
  return Number.isFinite(v) ? v : 0;
}

// ------------------------------------------------------- admin auth (HMAC)

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueToken(env) {
  const exp = Date.now() + 12 * 3600 * 1000;
  const mac = await hmacHex(env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD, String(exp));
  return exp + "." + mac;
}

async function checkToken(env, req) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [expStr, mac] = token.split(".");
  if (!expStr || !mac) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = await hmacHex(env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD, expStr);
  return mac === expect;
}

// -------------------------------------------------------------- KV session

async function loadSession(env, sid) {
  if (!env.DIARY_KV || !sid) return null;
  try {
    const raw = await env.DIARY_KV.get("s:" + sid);
    const data = raw ? JSON.parse(raw) : null;
    return data && Array.isArray(data.entries) ? data : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function saveSession(env, sid, session, cfg) {
  if (!env.DIARY_KV) return;
  if (session.entries.length > cfg.maxMemories) {
    session.entries = session.entries.slice(session.entries.length - cfg.maxMemories);
  }
  try {
    await env.DIARY_KV.put("s:" + sid, JSON.stringify(session));
  } catch (e) {
    console.error("session save failed", e);
  }
}

function buildCatalog(session, size, tz) {
  const lines = [];
  const ids = [];
  const recent = session.entries.slice().reverse().slice(0, size);
  recent.forEach((e, i) => {
    const gist = (e.t || "").trim() ? oneLine(e.t, 70) : `(reply: ${oneLine(e.r, 70)})`;
    lines.push(`${i + 1}. ${spokenDate(e.id, tz)} — ${gist}`);
    ids.push(e.id);
  });
  return { lines, ids };
}

function turnText(catalogLines, avgWords) {
  const wordHint = avgWords ? ` Keep your reply to approximately ${avgWords} words (this applies to ~70% of your replies).` : "";
  if (!catalogLines.length) return "Reply to what is written in the diary." + wordHint;
  return `Memory catalog (newest first):\n${catalogLines.join("\n")}\n\nReply to what is written in the diary.${wordHint}`;
}

// ------------------------------------------------------------- chat (SSE)

class ReplyRunner {
  constructor(catalogIds, send, maxChars) {
    this.parser = new StreamParser(catalogIds);
    this.acc = "";
    this.send = send;
    this.gotContent = false;
    this.reply = "";
    this.transcript = null;
    this.showId = null;
    this.maxChars = maxChars || Infinity;
    this.capped = false;
  }
  feed(frag) {
    this.acc += frag;
    for (const ev of this.parser.advance(this.acc, false)) this.emit(ev);
  }
  finish() {
    for (const ev of this.parser.advance(this.acc, true)) this.emit(ev);
  }
  emit(ev) {
    if (ev.err) throw new ChatError(0, ev.err);
    if (ev.type === "ink") {
      if (this.capped) return;
      let text = ev.text;
      const room = this.maxChars - this.reply.length;
      if (text.length > room) {
        let cut = Math.max(0, room);
        const b = text.slice(0, cut);
        const m = b.match(/.*[.!?\u2026]\s*$|.*[，、;；:：\s]/s);
        if (m && m[0].trim().length >= 8) cut = m[0].length;
        text = text.slice(0, cut).trimEnd() + "\u2026";
        this.capped = true;
      }
      this.gotContent = true;
      this.reply += (this.reply ? " " : "") + text.trim();
      this.send({ type: "ink", text });
    } else if (ev.type === "show") {
      this.showId = ev.id;
      this.send({ type: "show", id: ev.id });
    } else if (ev.type === "transcript") {
      this.transcript = ev.text;
    }
  }
}

async function runStream(env, prov, messages, cfg, runner) {
  for await (const frag of streamChat(env, prov, messages, cfg.maxTokens)) runner.feed(frag);
  runner.finish();
}

async function handleChat(req, env) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const cfg = await loadConfig(env);
  const sid = String(payload.sid || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  const image = typeof payload.image === "string" ? payload.image : "";
  if (!sid || !image.startsWith("data:image/")) return json({ error: "bad request" }, 400);

  const provs = providers(env);
  const session = env.DIARY_KV ? await loadSession(env, sid) : null;
  const remember = !!session && cfg.historyTurns >= 0;

  const tz = tzOffset(env);
  const catalog = session ? buildCatalog(session, cfg.catalogSize, tz) : { lines: [], ids: [] };
  const history = session
    ? session.entries.slice(-cfg.historyTurns).filter((e) => e.t).map((e) => [e.t, e.r])
    : [];

  const system = PERSONA + (session ? MEMORY_PROTOCOL : "");
  const historyMsgs = [];
  for (const [t, r] of history) {
    historyMsgs.push({ role: "user", content: `(an earlier page) ${t}` });
    historyMsgs.push({ role: "assistant", content: r });
  }
  const userText = turnText(catalog.lines, cfg.avgReplyWords);
  const withImage = [
    { type: "text", text: userText },
    { type: "image_url", image_url: { url: image } },
  ];
  const msgsWithImage = [
    { role: "system", content: system },
    ...historyMsgs,
    { role: "user", content: withImage },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try { controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n")); } catch { /* closed */ }
      };
      const runner = new ReplyRunner(catalog.ids, send, cfg.maxReplyChars);
      try {
        try {
          await runStream(env, provs.primary, msgsWithImage, cfg, runner);
        } catch (e) {
          if (runner.gotContent) throw e;
          if (e instanceof ImageError && provs.zhipu.keys.length) {
            try {
              const transcript = await transcribeInk(env, provs.zhipu, image);
              const textTurn =
                (catalog.lines.length ? `Memory catalog (newest first):\n${catalog.lines.join("\n")}\n\n` : "") +
                `The writer's ink reads:\n"${transcript}"\n\nReply to what is written in the diary.` +
                (cfg.avgReplyWords ? ` Keep your reply to approximately ${cfg.avgReplyWords} words.` : "");
              const textMsgs = [
                { role: "system", content: system },
                ...historyMsgs,
                { role: "user", content: textTurn },
              ];
              await runStream(env, provs.primary, textMsgs, cfg, runner);
            } catch (e2) {
              if (runner.gotContent) throw e2;
              await runStream(env, provs.zhipu, msgsWithImage, cfg, runner);
            }
          } else if (provs.zhipu.keys.length) {
            await runStream(env, provs.zhipu, msgsWithImage, cfg, runner);
          } else {
            throw e;
          }
        }

        if (session) {
          const entry = {
            id: Math.floor(Date.now() / 1000),
            t: clean(runner.transcript || "").slice(0, 2000),
            r: runner.reply.slice(0, 4000),
            s: Array.isArray(payload.strokes) ? payload.strokes : [],
          };
          session.entries.push(entry);
          await saveSession(env, sid, session, cfg);
        }
      } catch (e) {
        const msg = e instanceof ChatError && e.status
          ? `The diary falls silent. (${e.status === 429 ? "too many pages at once — rest a moment" : "http " + e.status})`
          : "The diary falls silent. (the oracle cannot be reached)";
        send({ type: "error", message: msg, detail: String(e?.message || e).slice(0, 300) });
      } finally {
        send({ type: "done" });
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

// ------------------------------------------------------------- admin APIs

async function adminState(req, env) {
  if (!(await checkToken(env, req))) return json({ error: "unauthorized" }, 401);
  const cfg = await loadConfig(env);
  const provs = providers(env);
  return json({
    config: cfg,
    defaults: DEFAULT_CONFIG,
    builtinThemes: BUILTIN_THEMES,
    env: {
      kvBound: !!env.DIARY_KV,
      agnesKeys: provs.primary.keys.length,
      zhipuKeys: provs.zhipu.keys.length,
      agnesModel: provs.primary.model,
      agnesBase: provs.primary.base,
      zhipuModel: provs.zhipu.model,
      zhipuBase: provs.zhipu.base,
      passwordIsDefault: (env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD) === DEFAULT_ADMIN_PASSWORD,
    },
  });
}

async function adminConfig(req, env) {
  if (!(await checkToken(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.DIARY_KV) return json({ error: "请先在 CF 控制台为本 Worker 绑定 KV（变量名 DIARY_KV）后再保存配置" }, 409);
  let patch;
  try { patch = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const merged = mergeConfig({ ...(await loadConfig(env)), ...patch });
  await env.DIARY_KV.put("config", JSON.stringify(merged));
  return json({ ok: true, config: merged });
}

async function adminForget(req, env) {
  if (!(await checkToken(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.DIARY_KV) return json({ error: "未绑定 KV" }, 409);
  let deleted = 0;
  let cursor;
  do {
    const list = await env.DIARY_KV.list({ prefix: "s:", cursor, limit: 1000 });
    if (list.keys.length) {
      await Promise.all(list.keys.map((k) => env.DIARY_KV.delete(k.name)));
      deleted += list.keys.length;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return json({ ok: true, deleted });
}

// ------------------------------------------------------- file upload / serve

async function handleUpload(req, env) {
  if (!(await checkToken(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.DIARY_KV) return json({ error: "KV not bound" }, 409);
  try {
    const ct = req.headers.get("content-type") || "";
    let ab, fileName, fileType;
    if (ct.indexOf("multipart/form-data") === 0) {
      const fd = await req.formData();
      const file = fd.get("file");
      if (!file) return json({ error: "no file" }, 400);
      ab = await file.arrayBuffer();
      fileName = file.name || "upload";
      fileType = file.type || "application/octet-stream";
    } else {
      ab = await req.arrayBuffer();
      fileName = req.headers.get("X-File-Name") || "upload.bin";
      fileType = ct || "application/octet-stream";
    }
    if (!ab || ab.byteLength === 0) return json({ error: "empty file" }, 400);
    // Max 25MB
    if (ab.byteLength > 25 * 1024 * 1024) return json({ error: "file too large" }, 413);
    // Generate key
    const hashBuf = await crypto.subtle.digest("SHA-256", ab);
    const hashArr = new Uint8Array(hashBuf);
    let hashStr = "";
    for (let i = 0; i < 8; i++) {
      const h = hashArr[i].toString(16);
      hashStr += h.length === 1 ? "0" + h : h;
  }
    const prefix = fileType.indexOf("audio/") === 0 ? "aud" : "file";
    const key = prefix + "_" + hashStr;
    await env.DIARY_KV.put(key, ab, {
      metadata: { contentType: fileType, fileName, uploadedAt: new Date().toISOString() },
    });
    return json({ ok: true, key, url: "/file/" + key, size: ab.byteLength, type: fileType, name: fileName });
  } catch (e) {
    return json({ error: "upload failed: " + e.message }, 500);
  }
}

async function serveFile(key, env) {
  if (!env.DIARY_KV) return new Response("KV not configured", { status: 500 });
  try {
    const r = await env.DIARY_KV.getWithMetadata(key, { type: "arrayBuffer" });
    if (!r || !r.value) return new Response("Not found", { status: 404 });
    const ct = (r.metadata && r.metadata.contentType) || "application/octet-stream";
    return new Response(r.value, {
      headers: {
        "Content-Type": ct,
        "Content-Length": String(r.value.byteLength),
        "Cache-Control": "public, max-age=86400",
        "Accept-Ranges": "bytes",
      },
    });
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500 });
  }
}

// ------------------------------------------------------------------ router

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // WeChat verification file — served at root without auth
    if (p.length > 1 && !p.startsWith("/api/") && !p.startsWith("/file/") && p !== "/admin" && p !== "/") {
      const cfg = await loadConfig(env);
      if (cfg.wechatVerifyName && p === "/" + cfg.wechatVerifyName) {
        return new Response(cfg.wechatVerifyContent || "", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    }

    // File serve: /file/:key
    if (p.startsWith("/file/")) {
      return serveFile(p.slice(6), env);
    }

    if (p.startsWith("/api/")) {
      if (req.method === "POST" && p === "/api/login") {
        const body = await req.json().catch(() => ({}));
        const expected = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
        if (typeof body.password === "string" && body.password === expected) {
          return json({ ok: true, token: await issueToken(env) });
        }
        return json({ ok: false, error: "密码不正确" }, 403);
      }
      if (p === "/api/config" && req.method === "GET") {
        return json(publicConfig(env, await loadConfig(env)));
      }
      if (p === "/api/chat" && req.method === "POST") {
        return handleChat(req, env);
      }
      if (p === "/api/recall" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const sid = String(body.sid || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
        const session = await loadSession(env, sid);
        const entry = session?.entries.find((e) => e.id === Number(body.id));
        if (!entry) return json({ error: "the diary lost that page" }, 404);
        return json({
          id: entry.id,
          date: spokenDate(entry.id, tzOffset(env)),
          transcript: entry.t || "",
          reply: entry.r || "",
          strokes: entry.s || [],
        });
      }
      if (p === "/api/upload" && req.method === "POST") {
        return handleUpload(req, env);
      }
      if (p === "/api/admin/state") return adminState(req, env);
      if (p === "/api/admin/config" && req.method === "POST") return adminConfig(req, env);
      if (p === "/api/admin/forget" && req.method === "POST") return adminForget(req, env);
      return json({ error: "not found" }, 404);
    }

    if (p === "/admin" || p === "/admin/") {
      return env.ASSETS.fetch(new URL("/admin.html", req.url));
    }

    return env.ASSETS.fetch(req);
  },
};
