// Tom Riddle's Diary — front-end conductor v2.
//
// Canvas-based flowing background, full feature set.

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
const btnDim = $("btn-dim");
const bgCanvas = $("bg-canvas");
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
  dimmed: false,
  replyDismissTimer: 0,
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

// ============================================= CANVAS FLOWING BACKGROUND

const BG = {
  ctx: null,
  w: 0, h: 0,
  orbs: [],
  raf: 0,
  startTime: 0,
};

function initCanvasBackground() {
  BG.ctx = bgCanvas.getContext("2d");
  BG.startTime = performance.now();

  // Rich, deep color palette with same-hue variations (different shades)
  // Each group: base hue with light and dark variants
  const orbDefs = [
    // Blues (3 shades)
    { h: 220, s: 65, l: 28, r: 0.38 },
    { h: 225, s: 55, l: 40, r: 0.30 },
    { h: 215, s: 70, l: 22, r: 0.34 },
    // Purples (3 shades)
    { h: 270, s: 60, l: 25, r: 0.36 },
    { h: 280, s: 50, l: 38, r: 0.28 },
    { h: 260, s: 65, l: 20, r: 0.32 },
    // Teals (2 shades)
    { h: 175, s: 55, l: 25, r: 0.30 },
    { h: 180, s: 45, l: 35, r: 0.26 },
    // Warm accents (2 shades)
    { h: 340, s: 50, l: 28, r: 0.24 },
    { h: 20, s: 55, l: 30, r: 0.22 },
    // Gold accent
    { h: 45, s: 60, l: 25, r: 0.20 },
    // Deep green
    { h: 150, s: 45, l: 22, r: 0.28 },
  ];

  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

  BG.orbs = orbDefs.map((def, i) => ({
    h: def.h + rnd(-8, 8),
    s: def.s + rnd(-5, 5),
    l: def.l + rnd(-3, 3),
    r: def.r,
    // Sine wave motion parameters
    xFreq: rnd(0.08, 0.25),   // x oscillation frequency
    yFreq: rnd(0.06, 0.20),   // y oscillation frequency
    xAmp: rnd(0.15, 0.35),    // x amplitude (fraction of width)
    yAmp: rnd(0.15, 0.30),    // y amplitude (fraction of height)
    xPhase: rnd(0, Math.PI * 2),
    yPhase: rnd(0, Math.PI * 2),
    xBase: rnd(0.1, 0.9),     // base position (fraction)
    yBase: rnd(0.1, 0.9),
    // Lightness wave (same hue, different shades over time)
    lFreq: rnd(0.03, 0.12),
    lAmp: rnd(3, 8),
    lPhase: rnd(0, Math.PI * 2),
    // Alpha wave
    aFreq: rnd(0.02, 0.08),
    aBase: rnd(0.3, 0.55),
    aAmp: rnd(0.1, 0.2),
    aPhase: rnd(0, Math.PI * 2),
  }));

  resizeBgCanvas();
  window.addEventListener("resize", resizeBgCanvas);
  animateBackground();
}

function resizeBgCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  BG.w = window.innerWidth;
  BG.h = window.innerHeight;
  bgCanvas.width = Math.round(BG.w * dpr);
  bgCanvas.height = Math.round(BG.h * dpr);
  BG.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function animateBackground() {
  const t = (performance.now() - BG.startTime) / 1000;
  const ctx = BG.ctx;
  const w = BG.w, h = BG.h;

  // Dark base
  ctx.fillStyle = "#14101c";
  ctx.fillRect(0, 0, w, h);

  // Draw each orb as a large radial gradient
  ctx.globalCompositeOperation = "screen";

  for (const orb of BG.orbs) {
    const x = (orb.xBase + Math.sin(t * orb.xFreq + orb.xPhase) * orb.xAmp) * w;
    const y = (orb.yBase + Math.cos(t * orb.yFreq + orb.yPhase) * orb.yAmp) * h;
    const radius = orb.r * Math.max(w, h);

    // Animate lightness for same-hue shade variation
    const l = orb.l + Math.sin(t * orb.lFreq + orb.lPhase) * orb.lAmp;
    // Animate alpha for breathing effect
    const alpha = clamp(orb.aBase + Math.sin(t * orb.aFreq + orb.aPhase) * orb.aAmp, 0.1, 0.7);

    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, `hsla(${orb.h}, ${orb.s}%, ${l}%, ${alpha})`);
    grad.addColorStop(0.4, `hsla(${orb.h}, ${orb.s}%, ${l * 0.7}%, ${alpha * 0.5})`);
    grad.addColorStop(1, `hsla(${orb.h}, ${orb.s}%, ${l * 0.3}%, 0)`);

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.globalCompositeOperation = "source-over";

  BG.raf = requestAnimationFrame(animateBackground);
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
    const availW = sw - 28, availH = sh - 100;
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
  set("#btn-dim", cfg.resetBtnSize || 44);
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
    btnReset.classList.add("hidden");
    whisper("Write with your pen.");

    // Auto-dismiss reply after configurable time
    clearTimeout(state.replyDismissTimer);
    const dismissMs = state.config?.replyDismissMs || 0;
    if (dismissMs > 0) {
      state.replyDismissTimer = setTimeout(() => {
        if (state.pageHasReply && !state.busy) {
          hand.fadeOutClear(420);
          state.pageHasReply = false;
          whisper("");
        }
      }, dismissMs);
    }
    // Whisper auto-hide
    setTimeout(() => { if (whisperEl.textContent === "Write with your pen.") whisper(""); }, 5000);
  } catch (e) {
    clearTimeout(timeoutId);
    if (ac.signal.aborted) { state.busy = false; btnReset.classList.add("hidden"); return; }
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
    clearTimeout(state.replyDismissTimer);
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

    const cacheCanvas = document.createElement("canvas");
    cacheCanvas.width = replyCanvas.width;
    cacheCanvas.height = replyCanvas.height;
    const cacheCtx = cacheCanvas.getContext("2d");

    for (let si = 0; si < strokes.length; si++) {
      if (!state.conjuring) return;
      const pts = strokes[si];
      if (si > 0) drawStroke(cacheCtx, strokes[si - 1], faded, 0.42, 1);
      const steps = Math.max(1, Math.floor(pts.length / 6));
      for (let i = 1; i <= pts.length; i += steps) {
        if (!state.conjuring) return;
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, hand.w, hand.h);
        rctx.drawImage(cacheCanvas, 0, 0, cacheCanvas.width, cacheCanvas.height, 0, 0, hand.w, hand.h);
        hand.drawCenteredLine(entry.date, hand.h * 0.085, 0.55, 0.8);
        drawStroke(rctx, pts.slice(0, i + 1), faded, 0.42, 1);
        await new Promise((r) => setTimeout(r, 16));
      }
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
      const p = document.documentElement.requestFullscreen?.() || document.documentElement.webkitRequestFullscreen?.();
      if (p) await p;
      else state.cssFullscreen = true;
    } catch { state.cssFullscreen = true; }
  }
  syncFullscreenUI();
}

async function toggleLandscape() {
  if (!(document.fullscreenElement || state.cssFullscreen)) return;
  state.forceLandscape = !state.forceLandscape;
  $("btn-landscape").classList.toggle("active", state.forceLandscape);
  try {
    if (state.forceLandscape && document.fullscreenElement && screen.orientation?.lock) {
      await screen.orientation.lock("landscape").catch(() => {});
    } else if (!state.forceLandscape && screen.orientation?.unlock) {
      screen.orientation.unlock();
    }
  } catch { /* ok */ }
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
    }).catch(() => {});
  }
}

// --------------------------------------------------------- easter egg

function handleIconClick() {
  if (state.config?.easterEggEnabled === false) return;
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
  footerContent.innerHTML = html || "";
}

function applyGuide(html) {
  if (html) guideContent.innerHTML = html;
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
  pad.pressureMul = state.config.pressureSensitivity || 1.5;
  hand.speed = state.config.writeSpeed || 55;
  hand.weight = Math.round(400 + 300 * clamp(((state.config.strokeWidth || 1) - 0.2) / 2.8, 0, 1));

  applyButtonSizes();
  buildSwatches();
  const savedId = localStorage.getItem("trd.theme");
  const theme = state.themes.find((t) => t.id === savedId) || state.themes[0];
  if (theme) applyTheme(theme, false);

  paperSize();
  syncRotation();

  applyFooter(state.config.footerHtml || "");
  applyGuide(state.config.guideHtml || "");

  // Music button
  if (state.config.musicUrl) {
    btnMusic.classList.remove("hidden");
  }

  // Start canvas background animation
  initCanvasBackground();

  try { await document.fonts.load(`${hand.weight} 40px "Dancing Script"`); } catch { /* ok */ }

  // ---- pointer wiring
  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (state.busy && !state.pageHasReply && !state.conjuring && !state.guideOpen) return;
    const consumed = newPageIfNeeded();
    if (consumed) return;
    clearTimeout(state.idleTimer);
    clearTimeout(state.replyDismissTimer);
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

  // ---- controls
  $("btn-eraser").addEventListener("click", (e) => {
    pad.eraseTool = !pad.eraseTool;
    e.currentTarget.classList.toggle("active", pad.eraseTool);
    clearTimeout(state.eraserTimer);
    if (pad.eraseTool) {
      state.eraserTimer = setTimeout(() => {
        pad.eraseTool = false;
        e.currentTarget.classList.remove("active");
      }, 1500);
    }
  });

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

  btnMusic.addEventListener("click", toggleMusic);

  // Reset button
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

  // Dim toggle button
  btnDim.addEventListener("click", () => {
    state.dimmed = !state.dimmed;
    document.body.classList.toggle("dim-controls", state.dimmed);
    btnDim.classList.toggle("active", state.dimmed);
  });

  // Easter egg
  pageIcon.addEventListener("click", handleIconClick);

  window.addEventListener("resize", () => { syncRotation(); });
  window.visualViewport?.addEventListener("resize", () => paperSize());

  whisper("write, then rest your quill");
  setTimeout(() => whisper(""), 5000);
}

boot();
