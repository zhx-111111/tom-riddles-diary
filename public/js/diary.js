// Tom Riddle's Diary — front-end conductor.
//
// Write, then rest your quill: the diary drinks your ink and Tom replies.
// The page is committed after a pen rest, rasterized to a PNG, and streamed
// to the worker; Tom's reply arrives chunk by chunk and writes itself in
// Dancing Script.

import { InkPad, drawStroke } from "./inkpad.js";
import { Hand } from "./hand.js";

const $ = (id) => document.getElementById(id);
const paper = $("paper");
const stage = $("stage");
const inkCanvas = $("ink-canvas");
const replyCanvas = $("reply-canvas");
const whisperEl = $("whisper");
const guideEl = $("guide");
const guideContent = $("guide-content");
const pageIcon = $("page-icon");
const btnMusic = $("btn-music");
const btnReset = $("btn-reset");
const bgMusic = $("bg-music");
const footerContent = $("footer-content");

// ------------------------------------------------------------------ state

const state = {
  config: null,
  themes: [],
  theme: null,
  busy: false,
  pageHasReply: false,
  conjuring: false,
  guideOpen: false,
  forceLandscape: false,
  cssFullscreen: false,
  abort: null,
  idleTimer: 0,
  writingGrace: 0,
  replyActive: false,
  iconClicks: 0,
  iconClickTimer: 0,
  eraserTimer: 0,
  musicPlaying: false,
};

let pad, hand;

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
  const sz = (state.config?.themeBtnSize || 34) + "px";
  box.style.setProperty("--swatch-size", sz);
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
    const availW = sw - 28, availH = sh - 100; // extra space for header+footer
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
  const fs = !!(document.fullscreenElement || state.cssFullscreen);
  // Landscape rotation only in fullscreen mode
  stage.classList.toggle("rotated", state.forceLandscape && portrait && fs);
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
    if (state.replyActive) return;
    state.writingGrace = setTimeout(() => document.body.classList.remove("writing"), 900);
  }
}

/// Liquid-glass desk background with more blobs for richer animation.
function initLiquidBackground() {
  const desk = $("desk");
  const palette = [
    "#b8d8ff", "#d4c5ff", "#b9a3e8", "#9aa7e8", "#c3e6c8",
    "#f6e7b8", "#ffd6e4", "#f5bfca", "#bfe6e8", "#e8c5f0",
    "#c8d8a8", "#f0d0b0",
  ];
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  const shuffled = palette.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < 10; i++) {
    const b = document.createElement("div");
    b.className = "blob k" + (i % 3);
    const size = rnd(22, 55);
    b.style.width = size + "vmax";
    b.style.height = size + "vmax";
    b.style.left = rnd(-12, 78) + "%";
    b.style.top = rnd(-14, 74) + "%";
    b.style.background = shuffled[i % shuffled.length];
    b.style.setProperty("--dur", rnd(18, 42).toFixed(1) + "s");
    b.style.setProperty("--delay", (-rnd(0, 30)).toFixed(1) + "s");
    desk.appendChild(b);
  }
}

// ----------------------------------------------------------- button sizes

function applyButtonSizes() {
  const cfg = state.config || {};
  const set = (sel, sz) => {
    document.querySelectorAll(sel).forEach(el => {
      el.style.setProperty("--btn-size", sz + "px");
    });
  };
  set("#btn-eraser", cfg.eraserBtnSize || 44);
  set("#btn-landscape", cfg.landscapeBtnSize || 44);
  set("#btn-fullscreen", cfg.fullscreenBtnSize || 44);
  set("#btn-reset", cfg.resetBtnSize || 44);
  // Whisper font size
  if (cfg.whisperFontSize) {
    whisperEl.style.setProperty("--whisper-size", cfg.whisperFontSize + "px");
  }
}

// ------------------------------------------------------------- page turns

async function commitPage() {
  if (state.busy || state.conjuring || state.guideOpen) return;
  if (!pad.hasInk()) return;
  clearTimeout(state.idleTimer);
  state.busy = true;

  // A lone large "?" summons the guide
  if (pad.looksLikeQuestionMark()) {
    state.busy = false;
    showGuide();
    return;
  }

  const png = pad.exportPNG(800, state.theme);
  const strokes = pad.serialize();
  if (!png) { state.busy = false; return; }

  whisper("the diary drinks your ink\u2026");
  const ac = new AbortController();
  state.abort = ac;

  // SSE timeout protection (30s)
  const timeoutId = setTimeout(() => ac.abort(), 30000);

  const req = fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: SID, image: png, strokes }),
    signal: ac.signal,
  });

  await pad.dissolve(1050);
  pad.reset();
  whisper("the diary is thinking\u2026");
  // Show reset button while thinking
  btnReset.classList.remove("hidden");

  try {
    const resp = await req;
    clearTimeout(timeoutId);
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
    // Hide reset button, show "Write with your pen."
    btnReset.classList.add("hidden");
    whisper("Write with your pen.");
    setTimeout(() => { if (whisperEl.textContent === "Write with your pen.") whisper(""); }, 5000);
  } catch (e) {
    clearTimeout(timeoutId);
    if (ac.signal.aborted) {
      state.busy = false;
      btnReset.classList.add("hidden");
      return;
    }
    whisper("");
    state.pageHasReply = true;
    hand.write("The diary falls silent. (the oracle cannot be reached)");
    btnReset.classList.add("hidden");
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
    btnReset.classList.add("hidden");
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

    hand.drawCenteredLine(entry.date, hand.h * 0.085, 0.55, 0.8);
    whisper("touch the page to return");

    const faded = state.theme.ink;
    const strokes = (entry.strokes || []).map((line) => line.map(([x, y, r]) => ({ x, y, w: r * 2 })));

    // Use offscreen canvas cache for better replay performance
    const cacheCanvas = document.createElement("canvas");
    cacheCanvas.width = replyCanvas.width;
    cacheCanvas.height = replyCanvas.height;
    const cacheCtx = cacheCanvas.getContext("2d");

    for (let si = 0; si < strokes.length; si++) {
      if (!state.conjuring) return;
      const pts = strokes[si];
      // Draw completed strokes to cache
      if (si > 0) {
        drawStroke(cacheCtx, strokes[si - 1], faded, 0.42, 1);
      }
      // Animate current stroke
      const steps = Math.max(1, Math.floor(pts.length / 6));
      for (let i = 1; i <= pts.length; i += steps) {
        if (!state.conjuring) return;
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, hand.w, hand.h);
        // Blit cached completed strokes
        rctx.drawImage(cacheCanvas, 0, 0, cacheCanvas.width, cacheCanvas.height, 0, 0, hand.w, hand.h);
        hand.drawCenteredLine(entry.date, hand.h * 0.085, 0.55, 0.8);
        // Draw partial current stroke
        drawStroke(rctx, pts.slice(0, i + 1), faded, 0.42, 1);
        await new Promise((r) => setTimeout(r, 16));
      }
      // Finalize this stroke into cache
      drawStroke(cacheCtx, pts, faded, 0.42, 1);
    }
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
  pad.dissolve(500);
}

// ------------------------------------------------------- fullscreen / rot.

function syncFullscreenUI() {
  const active = !!(document.fullscreenElement || state.cssFullscreen);
  document.body.classList.toggle("fs", active);
  $("btn-fullscreen").querySelector(".ic-expand").classList.toggle("hidden", active);
  $("btn-fullscreen").querySelector(".ic-compress").classList.toggle("hidden", !active);
  // In non-fullscreen, disable landscape
  if (!active && state.forceLandscape) {
    state.forceLandscape = false;
    $("btn-landscape")?.classList.remove("active");
    try { screen.orientation?.unlock?.(); } catch { /* ok */ }
  }
  syncRotation();
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
      else state.cssFullscreen = true;
    } catch {
      state.cssFullscreen = true;
    }
  }
  syncFullscreenUI();
}

async function toggleLandscape() {
  // Only works in fullscreen
  if (!(document.fullscreenElement || state.cssFullscreen)) return;
  state.forceLandscape = !state.forceLandscape;
  $("btn-landscape").classList.toggle("active", state.forceLandscape);
  try {
    if (state.forceLandscape && document.fullscreenElement && screen.orientation?.lock) {
      await screen.orientation.lock("landscape").catch(() => {});
    } else if (!state.forceLandscape && screen.orientation?.unlock) {
      screen.orientation.unlock();
    }
  } catch { /* orientation lock unsupported */ }
  syncRotation();
}

// ----------------------------------------------------------------- music

function toggleMusic() {
  const url = state.config?.musicUrl;
  if (!url) return;
  if (bgMusic.src !== url) bgMusic.src = url;
  if (state.musicPlaying) {
    bgMusic.pause();
    state.musicPlaying = false;
    btnMusic.querySelector(".ic-play").classList.remove("hidden");
    btnMusic.querySelector(".ic-pause").classList.add("hidden");
  } else {
    bgMusic.play().then(() => {
      state.musicPlaying = true;
      btnMusic.querySelector(".ic-play").classList.add("hidden");
      btnMusic.querySelector(".ic-pause").classList.remove("hidden");
    }).catch(() => { /* autoplay blocked or no source */ });
  }
}

// --------------------------------------------------------- easter egg

function handleIconClick() {
  state.iconClicks++;
  clearTimeout(state.iconClickTimer);
  state.iconClickTimer = setTimeout(() => { state.iconClicks = 0; }, 3000);
  if (state.iconClicks >= 6) {
    state.iconClicks = 0;
    window.location.href = "/admin";
  }
}

// ----------------------------------------------------------- footer

function applyFooter(html) {
  if (html) {
    footerContent.innerHTML = html;
  } else {
    footerContent.innerHTML = "";
  }
}

function applyGuide(html) {
  if (html) {
    guideContent.innerHTML = html;
  }
  // else keep default
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

  pad.strokeScale = state.config.strokeWidth || 1;
  hand.speed = state.config.writeSpeed || 55;
  hand.weight = Math.round(400 + 300 * clamp(((state.config.strokeWidth || 1) - 0.5) / 1.5, 0, 1));

  // Apply button sizes and whisper size
  applyButtonSizes();

  buildSwatches();
  const savedId = localStorage.getItem("trd.theme");
  const theme = state.themes.find((t) => t.id === savedId) || state.themes[0];
  if (theme) applyTheme(theme, false);

  paperSize();
  syncRotation();

  // Apply footer and guide from config
  applyFooter(state.config.footerHtml || "");
  applyGuide(state.config.guideHtml || "");

  // Music button visibility
  if (!state.config.musicUrl) {
    btnMusic.classList.add("hidden");
  }

  try { await document.fonts.load(`${hand.weight} 40px "Dancing Script"`); } catch { /* ok */ }

  // ---- pointer wiring
  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (state.busy && !state.pageHasReply && !state.conjuring && !state.guideOpen) return;
    const consumed = newPageIfNeeded();
    if (consumed) return;
    clearTimeout(state.idleTimer);
    markWriting(true);
    pad.pointerDown(e);
  });
  inkCanvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    // Fix: in landscape rotation, coordinates need to be transformed
    if (stage.classList.contains("rotated")) {
      // The canvas is inside the rotated stage, so pointer coordinates
      // relative to the canvas are already correct (the browser handles
      // the transform for pointer events within the rotated container)
    }
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

  pad.onChange = () => {};

  // ---- controls
  $("btn-eraser").addEventListener("click", (e) => {
    pad.eraseTool = !pad.eraseTool;
    e.currentTarget.classList.toggle("active", pad.eraseTool);
    // Auto-exit eraser after 1.5s of inactivity
    clearTimeout(state.eraserTimer);
    if (pad.eraseTool) {
      state.eraserTimer = setTimeout(() => {
        pad.eraseTool = false;
        e.currentTarget.classList.remove("active");
      }, 1500);
    }
  });

  // Reset eraser timer on each eraser use
  inkCanvas.addEventListener("pointerdown", () => {
    if (pad.eraseTool) {
      clearTimeout(state.eraserTimer);
      state.eraserTimer = setTimeout(() => {
        pad.eraseTool = false;
        $("btn-eraser").classList.remove("active");
      }, 1500);
    }
  });

  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  $("btn-landscape").addEventListener("click", toggleLandscape);
  document.addEventListener("fullscreenchange", syncFullscreenUI);
  document.addEventListener("webkitfullscreenchange", syncFullscreenUI);

  // Music toggle
  btnMusic.addEventListener("click", toggleMusic);

  // Reset button: abort current turn
  btnReset.addEventListener("click", () => {
    if (state.busy) {
      state.abort?.abort();
      state.busy = false;
      state.replyActive = false;
      document.body.classList.remove("writing");
      btnReset.classList.add("hidden");
      whisper("");
      pad.reset();
      hand.clearNow();
      state.pageHasReply = false;
    }
  });

  // Easter egg: 6 clicks on app icon → /admin
  pageIcon.addEventListener("click", handleIconClick);

  window.addEventListener("resize", () => { syncRotation(); });
  window.visualViewport?.addEventListener("resize", () => paperSize());

  whisper("write, then rest your quill");
  setTimeout(() => whisper(""), 5000);
}

boot();
