// Tom Riddle's Diary — front-end conductor.
//
// Write, then rest your quill: the diary drinks your ink and Tom replies.
// The page is committed after a pen rest (2.8 s by default, as in the
// original), rasterized to a PNG, and streamed to the worker; Tom's reply
// arrives sentence by sentence and writes itself in Dancing Script.

import { InkPad, drawStroke } from "./inkpad.js";
import { Hand } from "./hand.js";

const $ = (id) => document.getElementById(id);
const paper = $("paper");
const stage = $("stage");
const inkCanvas = $("ink-canvas");
const replyCanvas = $("reply-canvas");
const whisperEl = $("whisper");
const guideEl = $("guide");

// ------------------------------------------------------------------ state

const state = {
  config: null,
  themes: [],
  theme: null,
  busy: false,           // a page turn is in flight
  pageHasReply: false,   // Tom has written on this page
  conjuring: false,      // a remembered page is showing
  guideOpen: false,
  forceLandscape: false,
  cssFullscreen: false,  // pseudo-fullscreen (iOS fallback)
  abort: null,
  idleTimer: 0,
  writingGrace: 0,
};

let pad, hand;

// Session id (the diary keeps one memory per browser).
function sessionId() {
  let sid = localStorage.getItem("trd.sid");
  if (!sid) {
    sid = (crypto.randomUUID ? crypto.randomUUID() : "s" + Date.now() + Math.random().toString(36).slice(2)).replace(/-/g, "");
    localStorage.setItem("trd.sid", sid);
  }
  return sid;
}
const SID = sessionId();

// ---------------------------------------------------------------- helpers

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function whisper(text) {
  if (!text) { whisperEl.classList.remove("show"); return; }
  whisperEl.textContent = text;
  whisperEl.classList.add("show");
}

async function* sseEvents(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try { yield JSON.parse(line.slice(5).trim()); } catch { /* skip */ }
      }
    }
  }
}

// ------------------------------------------------------------------ themes

function applyTheme(theme, save = true) {
  state.theme = theme;
  paper.classList.remove("texture-midnight", "texture-map", "texture-aged", "texture-plain");
  paper.classList.add("texture-" + (theme.texture || "plain"));
  if ((theme.texture || "plain") === "plain") paper.style.setProperty("--paper-color", theme.paper);
  paper.style.setProperty("--ink-color", theme.ink);
  paper.style.setProperty("--ui-color", luminance(theme.paper) > 0.45 ? "#2b2016" : "#f4ede0");
  pad.setColor(theme.ink);
  pad.redraw();
  hand.setStyle({ ink: theme.ink });
  for (const el of document.querySelectorAll(".swatch")) {
    el.classList.toggle("active", el.dataset.id === theme.id);
  }
  if (save) localStorage.setItem("trd.theme", theme.id);
}

function buildSwatches() {
  const box = $("swatches");
  box.innerHTML = "";
  for (const t of state.themes) {
    const b = document.createElement("button");
    b.className = "swatch btn-glass";
    b.dataset.id = t.id;
    b.title = t.name;
    b.setAttribute("aria-label", t.name);
    b.style.background = t.paper;
    b.style.setProperty("--sw-ink", t.ink);
    b.addEventListener("click", () => applyTheme(t));
    box.appendChild(b);
  }
}

// ------------------------------------------------------------------ layout

function paperSize() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  let w, h;
  if (document.fullscreenElement || state.cssFullscreen) {
    w = sw; h = sh;
  } else {
    const availW = sw - 28, availH = sh - 28;
    w = Math.min(availW, 880);
    h = w * 1.36;
    if (h > availH) { h = availH; w = h / 1.36; }
  }
  paper.style.width = w + "px";
  paper.style.height = h + "px";
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  pad.resize(w, h, dpr);
  pad.penScale = clamp(w / 700, 0.75, 1.7);
  hand.resize(w, h, dpr);
  hand.setStyle({ fontSize: clamp(w * 0.045, 22, 40) });
}

function syncRotation() {
  const portrait = window.innerHeight > window.innerWidth;
  stage.classList.toggle("rotated", state.forceLandscape && portrait);
  paperSize();
}

// ------------------------------------------------------- writing controls

function scheduleIdle() {
  clearTimeout(state.idleTimer);
  if (!pad.hasInk() || state.busy || state.conjuring || state.guideOpen) return;
  state.idleTimer = setTimeout(commitPage, state.config.idleMs);
}

function markWriting(on) {
  clearTimeout(state.writingGrace);
  if (on) {
    document.body.classList.add("writing");
  } else {
    if (state.replyActive) return; // Tom is still writing — stay frosty
    state.writingGrace = setTimeout(() => document.body.classList.remove("writing"), 900);
  }
}

/// The liquid-glass desk: pastel blobs drifting on randomized paths —
/// every visit flows a little differently.
function initLiquidBackground() {
  const desk = $("desk");
  const palette = [
    "#b8d8ff", // 浅蓝
    "#d4c5ff", // 浅紫
    "#b9a3e8", // 紫罗兰
    "#9aa7e8", // 靛蓝
    "#c3e6c8", // 葱绿
    "#f6e7b8", // 鹅黄
    "#ffd6e4", // 浅粉
    "#f5bfca", // 浅玫瑰红
    "#bfe6e8", // 天青色
  ];
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  const shuffled = palette.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < 7; i++) {
    const b = document.createElement("div");
    b.className = "blob k" + (i % 3);
    const size = rnd(26, 52);
    b.style.width = size + "vmax";
    b.style.height = size + "vmax";
    b.style.left = rnd(-12, 78) + "%";
    b.style.top = rnd(-14, 74) + "%";
    b.style.background = shuffled[i % shuffled.length];
    b.style.setProperty("--dur", rnd(19, 38).toFixed(1) + "s");
    b.style.setProperty("--delay", (-rnd(0, 30)).toFixed(1) + "s");
    desk.appendChild(b);
  }
}

// ------------------------------------------------------------- page turns

async function commitPage() {
  if (state.busy || state.conjuring || state.guideOpen) return;
  if (!pad.hasInk()) return;
  clearTimeout(state.idleTimer);
  state.busy = true;

  // A lone large "?" summons the guide instead of the oracle (help.rs).
  if (pad.looksLikeQuestionMark()) {
    state.busy = false;
    showGuide();
    return;
  }

  const png = pad.exportPNG(800);
  const strokes = pad.serialize();
  if (!png) { state.busy = false; return; }

  whisper("the diary drinks your ink\u2026");
  const ac = new AbortController();
  state.abort = ac;
  // The request sets sail while the ink is still fading — first ink arrives
  // sooner, exactly like the original quill.
  const req = fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: SID, image: png, strokes }),
    signal: ac.signal,
  });

  await pad.dissolve(1050);
  pad.reset(); // the page is clean; clear the stroke model too
  whisper("the page is thinking\u2026");

  try {
    const resp = await req;
    if (!resp.ok) throw new Error("http " + resp.status);
    for await (const ev of sseEvents(resp)) {
      if (ev.type === "ink") {
        whisper("");
        state.pageHasReply = true;
        state.replyActive = true;
        document.body.classList.add("writing");
        hand.write(ev.text);
      } else if (ev.type === "show") {
        whisper("");
        await conjure(ev.id);
      } else if (ev.type === "error") {
        whisper("");
        state.pageHasReply = true;
        state.replyActive = true;
        document.body.classList.add("writing");
        hand.write(ev.message);
      } else if (ev.type === "done") {
        break;
      }
    }
    state.replyActive = false;
    if (!hand.raf) document.body.classList.remove("writing");
  } catch (e) {
    if (ac.signal.aborted) { state.busy = false; return; }
    whisper("");
    state.pageHasReply = true;
    hand.write("The diary falls silent. (the oracle cannot be reached)");
  }
  state.replyActive = false;
  state.busy = false;
}

function newPageIfNeeded() {
  if (state.conjuring) { dismissConjure(); return true; }
  if (state.guideOpen) { hideGuide(); return true; }
  if (state.pageHasReply) {
    hand.fadeOutClear(420);
    state.pageHasReply = false;
  }
  if (state.busy) {
    state.abort?.abort();
    state.busy = false;
    state.replyActive = false;
    document.body.classList.remove("writing");
    whisper("");
  }
  return false;
}

// --------------------------------------------------------------- conjuring

async function conjure(id) {
  try {
    const resp = await fetch("/api/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: SID, id }),
    });
    if (!resp.ok) { hand.write("The diary lost that page."); return; }
    const entry = await resp.json();
    state.conjuring = true;
    hand.clearNow();

    const rctx = replyCanvas.getContext("2d");
    const dpr = hand.dpr;
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.clearRect(0, 0, hand.w, hand.h);

    // The remembered page rises through the paper: the date first…
    hand.drawCenteredLine(entry.date, hand.h * 0.085, 0.55, 0.8);
    whisper("touch the page to return");

    // …your own handwriting rewriting itself stroke by stroke, faded…
    const faded = state.theme.ink;
    const strokes = (entry.strokes || []).map((line) => line.map(([x, y, r]) => ({ x, y, w: r * 2 })));
    for (const pts of strokes) {
      if (!state.conjuring) return;
      const steps = Math.max(1, Math.floor(pts.length / 6));
      for (let i = 1; i <= pts.length; i += steps) {
        if (!state.conjuring) return;
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, hand.w, hand.h);
        hand.drawCenteredLine(entry.date, hand.h * 0.085, 0.55, 0.8);
        for (const p2 of strokes) {
          if (p2 === pts) break;
          drawStroke(rctx, p2, faded, 0.42, 1);
        }
        drawStroke(rctx, pts.slice(0, i + 1), faded, 0.42, 1);
        await new Promise((r) => setTimeout(r, 16));
      }
    }
    // …and Tom's old reply, in faded ink.
    if (state.conjuring && entry.reply) {
      hand.drawInstant(entry.reply, 0.5, 0.16);
    }
  } catch {
    state.conjuring = false;
  }
}

function dismissConjure() {
  state.conjuring = false;
  hand.clearNow();
  whisper("");
}

// ------------------------------------------------------------------ guide

function showGuide() {
  state.guideOpen = true;
  guideEl.classList.remove("hidden");
  whisper("");
}

function hideGuide() {
  state.guideOpen = false;
  guideEl.classList.add("hidden");
  pad.dissolve(500); // the spent "?" fades into the paper
}

// ------------------------------------------------------- fullscreen / rot.

function syncFullscreenUI() {
  const active = !!(document.fullscreenElement || state.cssFullscreen);
  document.body.classList.toggle("fs", active);
  $("btn-fullscreen").querySelector(".ic-expand").classList.toggle("hidden", active);
  $("btn-fullscreen").querySelector(".ic-compress").classList.toggle("hidden", !active);
  paperSize();
}

async function toggleFullscreen() {
  const active = !!(document.fullscreenElement || state.cssFullscreen);
  if (active) {
    state.cssFullscreen = false;
    try { await document.exitFullscreen?.(); } catch { /* ok */ }
  } else {
    try {
      const p = document.documentElement.requestFullscreen?.() ||
        document.documentElement.webkitRequestFullscreen?.();
      if (p) await p;
      else state.cssFullscreen = true; // iOS Safari: CSS pseudo-fullscreen
    } catch {
      state.cssFullscreen = true;
    }
  }
  syncFullscreenUI();
}

async function toggleLandscape() {
  state.forceLandscape = !state.forceLandscape;
  $("btn-landscape").classList.toggle("active", state.forceLandscape);
  try {
    if (state.forceLandscape && document.fullscreenElement && screen.orientation?.lock) {
      await screen.orientation.lock("landscape").catch(() => {});
    } else if (!state.forceLandscape && screen.orientation?.unlock) {
      screen.orientation.unlock();
    }
  } catch { /* orientation lock unsupported — CSS rotation covers it */ }
  syncRotation();
}

// ------------------------------------------------------------------- boot

async function boot() {
  pad = new InkPad(inkCanvas);
  hand = new Hand(replyCanvas);

  try {
    const resp = await fetch("/api/config");
    state.config = await resp.json();
  } catch {
    state.config = { themes: [], writeSpeed: 55, strokeWidth: 1, idleMs: 2800 };
  }
  state.themes = state.config.themes || [];

  // Apply saved parameters.
  pad.strokeScale = state.config.strokeWidth || 1;
  hand.speed = state.config.writeSpeed || 55;
  hand.weight = Math.round(400 + 300 * clamp(((state.config.strokeWidth || 1) - 0.5) / 1.5, 0, 1));

  buildSwatches();
  const savedId = localStorage.getItem("trd.theme");
  const theme = state.themes.find((t) => t.id === savedId) || state.themes[0];
  if (theme) applyTheme(theme, false);

  paperSize();
  syncRotation();

  // Wait for the reply hand before the first ink can dry.
  try { await document.fonts.load(`${hand.weight} 40px "Dancing Script"`); } catch { /* ok */ }

  // ---- pointer wiring (pen / finger / mouse; coalesced for smoothness)
  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // While the oracle is thinking (no ink on the page yet), the pen waits —
    // same as the original diary, where a busy page ignores the pen.
    if (state.busy && !state.pageHasReply && !state.conjuring && !state.guideOpen) return;
    const consumed = newPageIfNeeded();
    if (consumed) return;
    clearTimeout(state.idleTimer);
    markWriting(true);
    pad.pointerDown(e);
  });
  inkCanvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    pad.pointerMove(e);
  });
  const endPointer = (e) => {
    pad.pointerUp(e);
    markWriting(false);
    scheduleIdle();
  };
  inkCanvas.addEventListener("pointerup", endPointer);
  inkCanvas.addEventListener("pointercancel", endPointer);
  inkCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

  pad.onChange = () => { /* reserved for future flourishes */ };

  // ---- controls
  $("btn-eraser").addEventListener("click", (e) => {
    pad.eraseTool = !pad.eraseTool;
    e.currentTarget.classList.toggle("active", pad.eraseTool);
  });
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  $("btn-landscape").addEventListener("click", toggleLandscape);
  document.addEventListener("fullscreenchange", syncFullscreenUI);
  document.addEventListener("webkitfullscreenchange", syncFullscreenUI);

  window.addEventListener("resize", () => { syncRotation(); });
  window.visualViewport?.addEventListener("resize", () => paperSize());

  whisper("write, then rest your quill");
  setTimeout(() => whisper(""), 5000);
}

boot();
