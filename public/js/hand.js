// Hand — Tom's flowing hand.
//
// Renders the oracle's reply in Dancing Script (the original diary's reply
// font), character by character, like ink appearing on the page. Sentences
// stream in from the worker exactly as the original quill received them —
// the pen starts writing before the model finishes.

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/// Small deterministic jitter so the hand looks alive, not typeset.
function jitter(i) {
  let h = Math.imul(i + 1, 0x9E3779B1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85EBCA6B);
  h ^= h >>> 13;
  return {
    rot: (((h & 0xff) % 7) - 3) * 0.008,
    dy: (((h >>> 8) % 5) - 2) * 0.4,
  };
}

export class Hand {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.w = 0; this.h = 0; this.dpr = 1;
    this.color = "#221610";
    this.fontSize = 30;
    this.weight = 550;
    this.speed = 55;          // ms per character (admin 书写速度)
    this.text = "";           // everything queued so far
    this.glyphs = [];         // laid-out {ch, x, y, rot, dy}
    this.times = [];          // reveal timestamp per glyph
    this.revealed = 0;        // glyphs fully revealed
    this.raf = 0;
    this.onFinished = null;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._layout();
    this._drawFrame(performance.now(), true);
  }

  setStyle({ ink, fontSize, weight, speed }) {
    if (ink) this.color = ink;
    if (fontSize) this.fontSize = fontSize;
    if (weight) this.weight = weight;
    if (speed) this.speed = speed;
    this._layout();
    this._drawFrame(performance.now(), true);
  }

  _font() {
    return `${this.weight} ${this.fontSize}px "Dancing Script", Georgia, cursive`;
  }

  /// Lay the whole queued text out into positioned glyphs (word-wrapped).
  _layout() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = this._font();
    const mx = this.w * 0.075;
    const top = this.h * 0.10;
    const bottom = this.h * 0.93;
    const lineH = this.fontSize * 1.42;
    const spaceW = ctx.measureText(" ").width;

    const glyphs = [];
    let x = mx, y = top;
    for (const line of this.text.split("\n")) {
      x = mx;
      for (const word of line.split(/\s+/)) {
        if (!word) continue;
        const ww = ctx.measureText(word).width;
        if (x + ww > this.w - mx && x > mx) { x = mx; y += lineH; }
        if (y > bottom) break;
        for (const ch of word) {
          const cw = ctx.measureText(ch).width;
          const j = jitter(glyphs.length);
          glyphs.push({ ch, x, y, rot: j.rot, dy: j.dy });
          x += cw;
        }
        x += spaceW;
      }
      y += lineH;
      if (y > bottom) break;
    }
    ctx.restore();

    const now = performance.now();
    const oldLen = this.glyphs.length;
    this.glyphs = glyphs;
    // Assign reveal times: keep already-scheduled times for existing glyphs,
    // chain new ones at `speed` apart, starting no earlier than now.
    const times = [];
    let last = now;
    for (let i = 0; i < glyphs.length; i++) {
      if (i < oldLen && i < this.times.length) {
        times.push(this.times[i]);
        last = Math.max(last, times[i]);
      } else {
        last = Math.max(now, last + this.speed);
        times.push(last);
      }
    }
    this.times = times;
    this.revealed = Math.min(this.revealed, glyphs.length);
    this._ensureLoop();
  }

  /// Append a streamed sentence to the page and start the pen.
  write(text) {
    if (!text) return;
    this.text += (this.text && !/\s$/.test(this.text) ? " " : "") + text.trim();
    this._layout();
  }

  _ensureLoop() {
    if (this.raf) return;
    const loop = (now) => {
      this.raf = 0;
      const done = this._drawFrame(now, false);
      if (!done) this.raf = requestAnimationFrame(loop);
      else this.onFinished?.();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /// Draw the frame; returns true when nothing more will animate.
  _drawFrame(now, forceAll) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!this.glyphs.length) return true;
    ctx.font = this._font();
    ctx.textBaseline = "alphabetic";
    let allRevealed = true;
    for (let i = 0; i < this.glyphs.length; i++) {
      const t = forceAll ? 1 : clamp((now - this.times[i]) / 150, 0, 1);
      if (t <= 0) { allRevealed = false; break; }
      if (t < 1) allRevealed = false;
      else this.revealed = Math.max(this.revealed, i + 1);
      const g = this.glyphs[i];
      const scale = 1.06 - 0.06 * t;
      ctx.save();
      ctx.globalAlpha = t;
      ctx.translate(g.x, g.y + g.dy + (1 - t) * 1.5);
      ctx.rotate(g.rot);
      ctx.scale(scale, scale);
      ctx.fillStyle = this.color;
      ctx.fillText(g.ch, 0, 0);
      ctx.restore();
    }
    return allRevealed;
  }

  /// Draw text instantly (no animation) at a given alpha — used for the
  /// faded reply of a conjured page. With keep=true the canvas is not
  /// cleared first (the replayed strokes underneath stay visible).
  drawInstant(text, alpha = 0.55, startYRatio = null, keep = false) {
    const saved = { text: this.text, glyphs: this.glyphs, times: this.times };
    this.text = text;
    this.glyphs = [];
    this.times = [];
    this._layout();
    if (startYRatio !== null) {
      // Shift the block vertically (caller positions it under the replayed ink).
      const dy = this.h * startYRatio - (this.glyphs[0]?.y ?? 0);
      for (const g of this.glyphs) g.y += dy;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!keep) ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = this._font();
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    for (const g of this.glyphs) {
      ctx.save();
      ctx.translate(g.x, g.y + g.dy);
      ctx.rotate(g.rot);
      ctx.fillText(g.ch, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    this.text = saved.text;
    this.glyphs = saved.glyphs;
    this.times = saved.times;
  }

  /// One centered line (a conjured page's date).
  drawCenteredLine(text, y, alpha = 0.6, sizeScale = 0.82) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${this.weight} ${Math.round(this.fontSize * sizeScale)}px "Dancing Script", Georgia, cursive`;
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    const w = ctx.measureText(text).width;
    ctx.fillText(text, (this.w - w) / 2, y);
    ctx.restore();
  }

  /// Fade the written reply away, then clear (a page turning).
  fadeOutClear(ms = 450) {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    const start = performance.now();
    const tick = (now) => {
      const t = clamp((now - start) / ms, 0, 1);
      this.canvas.style.opacity = String(1 - t);
      if (t < 1) requestAnimationFrame(tick);
      else {
        this.clearNow();
        this.canvas.style.opacity = "1";
      }
    };
    requestAnimationFrame(tick);
  }

  clearNow() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.text = "";
    this.glyphs = [];
    this.times = [];
    this.revealed = 0;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
