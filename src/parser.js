// Incremental stream parser — a faithful JavaScript port of `StreamParser`
// from the original riddle project (src/oracle.rs, MIT license).
//
// It routes the ⟦show:N⟧ conjuring directive, chunks prose into
// sentence-sized events, and splits off the ⁂-transcription postscript.
// Fed the RUNNING accumulated reply text, it emits each event exactly once.
// The writer never sees ⟦…⟧ glyphs or the ⁂ postscript — same as the
// original diary.

const SENTINEL = "\u2042"; // ⁂
const SHOW_OPEN = "\u27e6"; // ⟦
const SHOW_CLOSE = "\u27e7"; // ⟧

/// Trim and strip stray surrounding quotes from a reply fragment.
export function clean(s) {
  let t = s.trim();
  if (t.startsWith('"')) t = t.slice(1);
  if (t.endsWith('"')) t = t.slice(0, -1);
  return t;
}

/// Remove any ⟦…⟧ directive spans from inked prose, so a misbehaving model
/// that emits a directive mid/after prose never renders ⟦…⟧ as literal
/// glyphs in Tom's hand.
export function stripDirectives(s) {
  if (!s.includes(SHOW_OPEN)) return s;
  let out = "";
  let rest = s;
  for (;;) {
    const open = rest.indexOf(SHOW_OPEN);
    if (open < 0) break;
    out += rest.slice(0, open);
    const close = rest.indexOf(SHOW_CLOSE, open);
    if (close < 0) {
      rest = ""; // unterminated: drop the tail
      break;
    }
    rest = rest.slice(close + 1);
  }
  out += rest;
  return out.split(/\s+/).filter(Boolean).join(" ");
}

/// End of the LAST complete sentence in text[from..effective]: sentence
/// punctuation followed by whitespace or end-of-text. Chunks shorter than a
/// few characters are not worth an early delivery. Returns the offset just
/// past the punctuation, or null.
export function sentenceCut(text, effective, from) {
  let cut = null;
  for (let i = from; i < effective; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "\u2026") {
      const end = i + 1;
      const next = end < text.length ? text[end] : null;
      if ((next === null || /\s/.test(next)) && end - from >= 4) cut = end;
    }
  }
  return cut;
}

export class StreamParser {
  constructor(catalogIds) {
    this.delivered = 0;
    this.sentinel = null;
    this.routeChecked = false;
    this.emittedAny = false;
    this.catalogIds = catalogIds || [];
  }

  /// Feed the full accumulated reply text so far. `done` marks end of
  /// stream: flushes the tail and the transcription.
  advance(full, done) {
    const out = [];

    if (this.sentinel === null) {
      const i = full.indexOf(SENTINEL);
      if (i >= 0) this.sentinel = i;
    }
    // The reply body is everything before the ⁂ transcription postscript.
    const effective = this.sentinel === null ? full.length : this.sentinel;

    // Route: is this reply an incantation (⟦show:N⟧) rather than prose?
    // The directive is honored only when it LEADS the reply (we can't
    // un-ink), so hold output until the lead is settled.
    if (!this.routeChecked) {
      const lead = full.slice(this.delivered, effective).replace(/^\s+/, "");
      if (lead.startsWith(SHOW_OPEN)) {
        const closeRel = lead.indexOf(SHOW_CLOSE);
        if (closeRel < 0) {
          if (!done) return out; // directive still streaming in
          out.push({ err: "unfinished conjuring directive" });
          return out;
        }
        const inner = lead.slice(1, closeRel);
        const m = inner.toLowerCase().match(/^show\s*[:\s]\s*(\d+)\s*$/);
        const n = m ? parseInt(m[1], 10) : NaN;
        this.routeChecked = true;
        this.emittedAny = true;
        this.delivered = effective; // consume the whole body
        const id = Number.isInteger(n) ? this.catalogIds[n - 1] : undefined;
        if (id !== undefined) out.push({ type: "show", id });
        else out.push({ err: `the diary lost that page (${inner})` });
      } else if (lead === "") {
        if (!done) return out; // only whitespace so far — keep waiting
        this.routeChecked = true;
      } else {
        // Real prose leads: a normal reply.
        this.routeChecked = true;
      }
    }

    // Prose sentences, never crossing into the transcription postscript.
    if (this.delivered < effective) {
      const cut = sentenceCut(full, effective, this.delivered);
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
