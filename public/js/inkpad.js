// InkPad — the writer's pen.
//
// Captures pointer input (pen / finger / mouse), renders smooth anti-aliased
// ink, keeps a faithful stroke model, erases (two fingers or corner eraser),
// rasterizes to PNG, dissolves ink, detects "?".

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function pxHash(x, y) {
  let h = Math.imul(x | 0, 0x9E3779B1) ^ Math.imul(y | 0, 0x85EBCA6B);
  h ^= h >>> 13;
  h = Math.imul(h, 0xC2B2AE35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class InkPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.strokes = [];
    this.current = null;
    this.pointers = new Map();
    this.twoFinger = false;
    this.erasing = false;
    this.eraseTool = false;
    this.color = "#221610";
    this.strokeScale = 1.0;
    this.pressureMul = 1.5;  // configurable from admin
    this.penScale = 1.0;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.onChange = null;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.redraw();
  }

  setColor(c) { this.color = c; }
  hasInk() { return this.strokes.length > 0 || !!this.current; }

  reset() {
    this.strokes = [];
    this.current = null;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _prep(ctx) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._prep(ctx);
    for (const s of this.strokes) drawStroke(ctx, s.pts, this.color, 0.96, 1);
    if (this.current) drawStroke(ctx, this.current.pts, this.color, 0.96, 1);
  }

  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Enhanced pressure sensitivity: configurable multiplier
  widthFor(pt, prev) {
    let wf = 1;
    if (prev) {
      const d = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      const dt = Math.max(1, pt.t - prev.t);
      const v = d / dt;
      wf = clamp(1.15 - v * 0.18, 0.72, 1.18);
    }
    // Enhanced pressure with configurable sensitivity
    const p = clamp(pt.p, 0, 1);
    const sens = this.pressureMul || 1.5;
    const pf = 0.15 + Math.pow(p, 1.0 / sens) * (1.6 + sens * 0.3);
    return 1.8 * this.penScale * this.strokeScale * wf * pf * 2;
  }

  pointerDown(e) {
    const pos = this.toLocal(e);
    this.pointers.set(e.pointerId, pos);
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ok */ }

    if (this.pointers.size === 2) {
      if (this.current && this.current.pts.length) this.strokes.push(this.current);
      this.current = null;
      this.twoFinger = true;
      const [a, b] = [...this.pointers.values()];
      this.eraseAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 26);
      this.onChange?.();
      return "erase";
    }
    if (this.pointers.size > 2) return "ignore";

    if (this.eraseTool) {
      this.erasing = true;
      this.eraseAt(pos, 17);
      this.onChange?.();
      return "erase";
    }

    this.current = { pts: [] };
    this._addPoint(e, pos);
    return "draw";
  }

  pointerMove(e) {
    const pos = this.toLocal(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pos);

    if (this.twoFinger && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this.eraseAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 26);
      return;
    }
    if (this.erasing) { this.eraseAt(pos, 17); return; }
    if (!this.current) return;

    const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) this._addPoint(ev, this.toLocal(ev));
  }

  pointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.twoFinger && this.pointers.size < 2) this.twoFinger = false;
    if (this.erasing && this.pointers.size === 0) this.erasing = false;
    if (this.current) {
      if (this.current.pts.length) this.strokes.push(this.current);
      this.current = null;
      this.onChange?.();
    }
  }

  _addPoint(e, pos) {
    const prev = this.current.pts[this.current.pts.length - 1];
    if (prev && pos.x === prev.x && pos.y === prev.y) return;
    const pt = {
      x: pos.x, y: pos.y,
      t: e.timeStamp || performance.now(),
      p: e.pressure && e.pressure > 0 ? e.pressure : 0.5,
    };
    pt.w = this.widthFor(pt, prev);
    if (prev) pt.w = prev.w * 0.4 + pt.w * 0.6; // slightly less smoothing for more responsive pressure
    this.current.pts.push(pt);
    this._renderTail();
    this.onChange?.();
  }

  _renderTail() {
    const pts = this.current.pts;
    const n = pts.length;
    if (!n) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 0.96;
    this._prep(ctx);
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (n === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineWidth = (pts[0].w + pts[1].w) / 2;
      ctx.stroke();
    } else {
      const a = pts[n - 3], b = pts[n - 2], c = pts[n - 1];
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = b.w;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  eraseAt(pos, r) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this._forgetNear(pos.x, pos.y, r);
  }

  _forgetNear(x, y, r) {
    const r2 = (r + 2) * (r + 2);
    const kept = [];
    for (const stroke of this.strokes) {
      let seg = [];
      for (const p of stroke.pts) {
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy <= r2) {
          if (seg.length) { kept.push({ pts: seg }); seg = []; }
        } else seg.push(p);
      }
      if (seg.length) kept.push({ pts: seg });
    }
    this.strokes = kept;
  }

  bbox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const consider = (p) => {
      const r = p.w / 2 + 2;
      x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - r);
      x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + r);
    };
    for (const s of this.strokes) for (const p of s.pts) consider(p);
    if (this.current) for (const p of this.current.pts) consider(p);
    if (x0 === Infinity) return null;
    return { x0, y0, x1, y1 };
  }

  serialize() {
    const out = [];
    for (const s of this.strokes) {
      const line = [];
      let lx = null, ly = null;
      for (let i = 0; i < s.pts.length; i++) {
        const p = s.pts[i];
        const keep = lx === null ||
          (p.x - lx) ** 2 + (p.y - ly) ** 2 >= 9 ||
          i === s.pts.length - 1;
        if (keep) {
          line.push([Math.round(p.x), Math.round(p.y), Math.max(1, Math.round(p.w / 2))]);
          lx = p.x; ly = p.y;
        }
      }
      if (line.length) out.push(line);
    }
    return out;
  }

  /// Rasterize ink to PNG. bgColor/inkColor adapt to theme.
  exportPNG(maxSide = 800, theme = null) {
    const b = this.bbox();
    if (!b) return null;
    const p = 20;
    const x0 = Math.max(0, b.x0 - p), y0 = Math.max(0, b.y0 - p);
    const x1 = Math.min(this.w, b.x1 + p), y1 = Math.min(this.h, b.y1 + p);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 4 || ch < 4) return null;
    const f = Math.max(1, Math.ceil(Math.max(cw, ch) / maxSide));
    const w = Math.max(1, Math.round(cw / f)), h = Math.max(1, Math.round(ch / f));
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d");

    // Dynamic background: dark theme → dark bg + light ink for better OCR
    const isDark = theme && theme.id === "midnight";
    octx.fillStyle = isDark ? "#000000" : "#ffffff";
    octx.fillRect(0, 0, w, h);
    octx.scale(1 / f, 1 / f);
    octx.translate(-x0, -y0);
    const inkColor = isDark ? "#f2ead8" : "#000000";
    for (const s of this.strokes) drawStroke(octx, s.pts, inkColor, 1, 1);
    if (this.current) drawStroke(octx, this.current.pts, inkColor, 1, 1);
    return off.toDataURL("image/png");
  }

  /// Dissolve using requestAnimationFrame for smoother performance.
  dissolve(durMs = 1100) {
    return new Promise((resolve) => {
      const b = this.bbox();
      if (!b) { resolve(); return; }
      const d = this.dpr, p = 10;
      const x0 = Math.max(0, Math.floor((b.x0 - p) * d));
      const y0 = Math.max(0, Math.floor((b.y0 - p) * d));
      const x1 = Math.min(this.canvas.width, Math.ceil((b.x1 + p) * d));
      const y1 = Math.min(this.canvas.height, Math.ceil((b.y1 + p) * d));
      const w = x1 - x0, h = y1 - y0;
      if (w <= 0 || h <= 0) { resolve(); return; }
      const img = this.ctx.getImageData(x0, y0, w, h);
      const data = img.data;
      const stages = 24;
      const buckets = Array.from({ length: stages }, () => []);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const ai = (py * w + px) * 4 + 3;
          if (data[ai] > 0) buckets[pxHash(x0 + px, y0 + py) % stages].push(ai);
        }
      }
      let s = 0;
      const stepMs = durMs / stages;
      let lastTime = performance.now();
      const tick = (now) => {
        if (s >= stages) { resolve(); return; }
        if (now - lastTime >= stepMs) {
          for (const ai of buckets[s]) data[ai] = 0;
          this.ctx.putImageData(img, x0, y0);
          s++;
          lastTime = now;
        }
        if (s < stages) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /// Detects a lone large "?" — very relaxed thresholds for mobile.
  looksLikeQuestionMark() {
    const strokes = this.strokes.map((s) => s.pts);
    if (!strokes.length || strokes.length > 4) return false;
    const k = this.h / 1872;
    let mainI = 0;
    for (let i = 1; i < strokes.length; i++) if (strokes[i].length > strokes[mainI].length) mainI = i;
    const main = strokes[mainI];
    if (main.length < 5) return false; // very relaxed
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of main) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const w = x1 - x0, h = y1 - y0;
    if (h < 120 * k || w < 25 * k || h < w * 0.5) return false; // very relaxed
    for (let i = 0; i < strokes.length; i++) {
      if (i === mainI) continue;
      const s = strokes[i];
      let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
      for (const p of s) {
        dx0 = Math.min(dx0, p.x); dy0 = Math.min(dy0, p.y);
        dx1 = Math.max(dx1, p.x); dy1 = Math.max(dy1, p.y);
      }
      if (Math.max(dx1 - dx0, dy1 - dy0) > 120 * k) return false;
      if ((dy0 + dy1) / 2 < y0 + h * 0.50) return false;
      if ((dx0 + dx1) / 2 < x0 - 120 * k || (dx0 + dx1) / 2 > x1 + 120 * k) return false;
    }
    const pts = main.map((p) => [p.x, p.y]);
    if (pts[0][1] > pts[pts.length - 1][1]) pts.reverse();
    const start = pts[0], end = pts[pts.length - 1];
    if (start[1] > y0 + h * 0.50 || end[1] < y0 + h * 0.45) return false;
    let topMinX = Infinity, topMaxX = -Infinity, topMaxXy = 0;
    for (const [x, y] of pts) {
      if (y <= y0 + h * 0.50) {
        if (x > topMaxX) { topMaxX = x; topMaxXy = y; }
        topMinX = Math.min(topMinX, x);
      }
    }
    if (topMaxX === -Infinity || topMaxX - topMinX < w * 0.30) return false; // relaxed
    if (topMaxXy < y0 + h * 0.04) return false;
    return true;
  }
}

export function drawStroke(ctx, pts, color, alpha = 0.96, widthScale = 1) {
  if (!pts.length) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, (pts[0].w / 2) * widthScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
  ctx.lineWidth = ((pts[0].w + pts[1].w) / 2) * widthScale;
  ctx.stroke();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    ctx.beginPath();
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.lineWidth = b.w * widthScale;
    ctx.stroke();
  }
  ctx.restore();
}
