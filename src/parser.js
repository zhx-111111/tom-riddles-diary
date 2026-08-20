// Incremental stream parser — routes ⟦show:N⟧ conjuring directives,
// chunks prose into small events for fast streaming feel, and splits off
// the ⁂-transcription postscript.

const SENTINEL = "\u2062"; // invisible separator
const SHOW_OPEN = "\u27e6"; // ⟦
const SHOW_CLOSE = "\u27e7"; // ⟧

/// Trim and strip stray surrounding quotes from a reply fragment.
export function clean(s) {
  let t = s.trim();
  if (t.startsWith('"')) t = t.slice(1);
  if (t.endsWith('"')) t = t.slice(0, -1);
  return t;
}

/// Remove any ⟦…⟧ directive spans from inked prose.
export function stripDirectives(s) {
  if (!s.includes(SHOW_OPEN)) return s;
  let out = "";
  let rest = s;
  for (;;) {
    const open = rest.indexOf(SHOW_OPEN);
    if (open < 0) break;
    out += rest.slice(0, open);
    const close = rest.indexOf(SHOW_CLOSE, open);
    if (close < 0) { rest = ""; break; }
    rest = rest.slice(close + 1);
  }
  out += rest;
  return out.split(/\s+/).filter(Boolean).join(" ");
}

/// Cut at sentence boundary OR after ~8 words for faster streaming feel.
export function inkCut(text, effective, from) {
  // First try sentence boundary (preferred)
  let sentCut = null;
  for (let i = from; i < effective; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "\u2026") {
      const end = i + 1;
      const next = end < text.length ? text[end] : null;
      if ((next === null || /\s/.test(next)) && end - from >= 4) sentCut = end;
    }
  }
  if (sentCut !== null) return sentCut;

  // Fall back to word boundary (~6-12 chars for faster streaming)
  const remaining = text.slice(from, effective);
  if (remaining.length < 6) return null;
  // Find a space after at least 5 chars
  const spaceIdx = remaining.indexOf(" ", 5);
  if (spaceIdx > 0 && spaceIdx < remaining.length - 1) {
    return from + spaceIdx + 1;
  }
  // No good word break, if we have enough text just cut
  if (remaining.length >= 15) return effective;
  return null;
}

export class StreamParser {
  constructor(catalogIds) {
    this.delivered = 0;
    this.sentinel = null;
    this.routeChecked = false;
    this.emittedAny = false;
    this.catalogIds = catalogIds || [];
  }

  /// Feed the full accumulated reply text so far. `done` marks end of stream.
  advance(full, done) {
    const out = [];

    if (this.sentinel === null) {
      const i = full.indexOf(SENTINEL);
      if (i >= 0) this.sentinel = i;
    }
    const effective = this.sentinel === null ? full.length : this.sentinel;

    // Route: is this reply a ⟦show:N⟧ conjuring directive?
    if (!this.routeChecked) {
      const lead = full.slice(this.delivered, effective).replace(/^\s+/, "");
      if (lead.startsWith(SHOW_OPEN)) {
        const closeRel = lead.indexOf(SHOW_CLOSE);
        if (closeRel < 0) {
          if (!done) return out;
          out.push({ err: "unfinished conjuring directive" });
          return out;
        }
        const inner = lead.slice(1, closeRel);
        const m = inner.toLowerCase().match(/^show\s*[:\s]\s*(\d+)\s*$/);
        const n = m ? parseInt(m[1], 10) : NaN;
        this.routeChecked = true;
        this.emittedAny = true;
        this.delivered = effective;
        const id = Number.isInteger(n) ? this.catalogIds[n - 1] : undefined;
        if (id !== undefined) out.push({ type: "show", id });
        else out.push({ err: `the diary lost that page (${inner})` });
      } else if (lead === "") {
        if (!done) return out;
        this.routeChecked = true;
      } else {
        this.routeChecked = true;
      }
    }

    // Prose chunks — emit frequently for fast streaming
    if (this.delivered < effective) {
      const cut = inkCut(full, effective, this.delivered);
      if (cut !== null) {
        const chunk = stripDirectives(clean(full.slice(this.delivered, cut)));
        if (chunk) {
          this.emittedAny = true;
          out.push({ type: "ink", text: chunk });
        }
        this.delivered = cut;
      }
    }

    if (done) {
      if (this.delivered < effective) {
        const rest = stripDirectives(clean(full.slice(this.delivered, effective).trim()));
        if (rest) {
          this.emittedAny = true;
          out.push({ type: "ink", text: rest });
        }
        this.delivered = effective;
      }
      if (this.sentinel !== null) {
        const t = full.slice(this.sentinel + 1).trim();
        if (t) out.push({ type: "transcript", text: t });
      }
      if (!this.emittedAny) out.push({ err: "empty reply" });
    }
    return out;
  }
}
