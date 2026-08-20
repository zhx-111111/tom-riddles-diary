// Runtime configuration: compile-time defaults (injected into the CF console
// as Worker vars by wrangler.jsonc), merged with overrides the admin panel
// stores in KV under the key "config".

export const DEFAULT_ADMIN_PASSWORD = "tomriddle1943";

/// Parameters the admin panel can change.
export const DEFAULT_CONFIG = {
  writeSpeed: 55,         // ms per character of Tom's hand
  strokeWidth: 1.0,       // 0.5 – 2.0, scales pen radius and reply weight
  historyTurns: 6,        // recent pages carried into each request
  catalogSize: 10,        // remembered pages listed for "show me…" conjuring
  idleMs: 2800,           // pen rest before the diary drinks the ink
  maxTokens: 2000,        // runaway guard on the reply
  maxReplyChars: 600,     // max characters Tom writes on one page
  maxMemories: 400,       // oldest pages beyond this are forgotten
  themes: [],             // custom themes: {id, name, paper, ink}
  avgReplyWords: 35,      // average reply word count (70% of replies)
  themeBtnSize: 34,       // theme swatch button size (px)
  landscapeBtnSize: 44,   // landscape button size (px)
  fullscreenBtnSize: 44,  // fullscreen button size (px)
  eraserBtnSize: 44,      // eraser button size (px)
  resetBtnSize: 44,       // reset button size (px)
  whisperFontSize: 15,    // "the diary is thinking" text size (px)
  musicUrl: "",           // external music URL for Hedwig's Theme
  footerHtml: "",         // footer HTML content (sandboxed)
  guideHtml: "",          // custom guide page HTML (overrides default)
};

/// Built-in letter papers.
export const BUILTIN_THEMES = [
  { id: "midnight", name: "Midnight Ink",     paper: "#000000", ink: "#f2ead8", texture: "midnight" },
  { id: "map",      name: "Marauder's Map",   paper: "#d9c69c", ink: "#43301c", texture: "map" },
  { id: "aged",     name: "Aged Letter",      paper: "#e8d5a3", ink: "#241812", texture: "aged" },
];

const NUM_FIELDS = [
  "writeSpeed", "strokeWidth", "historyTurns", "catalogSize", "idleMs",
  "maxTokens", "maxReplyChars", "maxMemories", "avgReplyWords",
  "themeBtnSize", "landscapeBtnSize", "fullscreenBtnSize", "eraserBtnSize",
  "resetBtnSize", "whisperFontSize",
];

const STR_FIELDS = ["musicUrl", "footerHtml", "guideHtml"];

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/// Merge KV overrides onto the defaults, sanitizing every field.
export function mergeConfig(overrides) {
  const cfg = { ...DEFAULT_CONFIG, themes: [] };
  if (overrides && typeof overrides === "object") {
    for (const k of NUM_FIELDS) {
      if (overrides[k] !== undefined) cfg[k] = overrides[k];
    }
    for (const k of STR_FIELDS) {
      if (typeof overrides[k] === "string") cfg[k] = overrides[k];
    }
    if (Array.isArray(overrides.themes)) {
      cfg.themes = overrides.themes
        .filter((t) => t && typeof t.name === "string" && /^#[0-9a-fA-F]{6}$/.test(t.paper || "") && /^#[0-9a-fA-F]{6}$/.test(t.ink || ""))
        .slice(0, 12)
        .map((t, i) => ({ id: "c" + i, name: t.name.slice(0, 24), paper: t.paper, ink: t.ink, texture: "plain" }));
    }
  }
  cfg.writeSpeed = clampNum(cfg.writeSpeed, 10, 500, DEFAULT_CONFIG.writeSpeed);
  cfg.strokeWidth = clampNum(cfg.strokeWidth, 0.5, 2.0, DEFAULT_CONFIG.strokeWidth);
  cfg.historyTurns = Math.round(clampNum(cfg.historyTurns, 0, 20, DEFAULT_CONFIG.historyTurns));
  cfg.catalogSize = Math.round(clampNum(cfg.catalogSize, 0, 30, DEFAULT_CONFIG.catalogSize));
  cfg.idleMs = clampNum(cfg.idleMs, 800, 8000, DEFAULT_CONFIG.idleMs);
  cfg.maxTokens = Math.round(clampNum(cfg.maxTokens, 256, 8192, DEFAULT_CONFIG.maxTokens));
  cfg.maxReplyChars = Math.round(clampNum(cfg.maxReplyChars, 100, 3000, DEFAULT_CONFIG.maxReplyChars));
  cfg.maxMemories = Math.round(clampNum(cfg.maxMemories, 10, 400, DEFAULT_CONFIG.maxMemories));
  cfg.avgReplyWords = Math.round(clampNum(cfg.avgReplyWords, 10, 200, DEFAULT_CONFIG.avgReplyWords));
  cfg.themeBtnSize = Math.round(clampNum(cfg.themeBtnSize, 20, 60, DEFAULT_CONFIG.themeBtnSize));
  cfg.landscapeBtnSize = Math.round(clampNum(cfg.landscapeBtnSize, 28, 70, DEFAULT_CONFIG.landscapeBtnSize));
  cfg.fullscreenBtnSize = Math.round(clampNum(cfg.fullscreenBtnSize, 28, 70, DEFAULT_CONFIG.fullscreenBtnSize));
  cfg.eraserBtnSize = Math.round(clampNum(cfg.eraserBtnSize, 28, 70, DEFAULT_CONFIG.eraserBtnSize));
  cfg.resetBtnSize = Math.round(clampNum(cfg.resetBtnSize, 28, 70, DEFAULT_CONFIG.resetBtnSize));
  cfg.whisperFontSize = Math.round(clampNum(cfg.whisperFontSize, 10, 28, DEFAULT_CONFIG.whisperFontSize));
  cfg.musicUrl = (cfg.musicUrl || "").slice(0, 500);
  cfg.footerHtml = (cfg.footerHtml || "").slice(0, 5000);
  cfg.guideHtml = (cfg.guideHtml || "").slice(0, 5000);
  return cfg;
}

export async function loadConfig(env) {
  let overrides = null;
  if (env.DIARY_KV) {
    try {
      overrides = JSON.parse(await env.DIARY_KV.get("config"));
    } catch { /* no overrides yet */ }
  }
  return mergeConfig(overrides);
}

/// Collapse whitespace to single spaces and cap at `max` chars.
export function oneLine(s, max) {
  return (s || "").split(/\s+/).filter(Boolean).join(" ").slice(0, max);
}

/// "the 6th of July, in the evening" — how the diary speaks of a moment.
export function spokenDate(idSec, tzHours) {
  const t = idSec + Math.round((tzHours || 0) * 3600);
  const days = Math.floor(t / 86400);
  const hour = Math.floor(((t % 86400) + 86400) % 86400 / 3600);
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - doe / 36524 + doe / 36524 - doe / 146096) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const suffix = d >= 11 && d <= 13 ? "th" : d % 10 === 1 ? "st" : d % 10 === 2 ? "nd" : d % 10 === 3 ? "rd" : "th";
  const tod = hour <= 4 ? "in the small hours" : hour <= 11 ? "in the morning" : hour <= 17 ? "in the afternoon" : hour <= 21 ? "in the evening" : "late at night";
  return `the ${d}${suffix} of ${MONTHS[m - 1]}, ${tod}`;
}

export function splitKeys(s) {
  return String(s || "").split(",").map((k) => k.trim()).filter(Boolean);
}

/// Public, non-secret config for the diary front end.
export function publicConfig(env, cfg) {
  return {
    name: "Tom Riddle's Diary",
    themes: [...BUILTIN_THEMES, ...cfg.themes],
    writeSpeed: cfg.writeSpeed,
    strokeWidth: cfg.strokeWidth,
    idleMs: cfg.idleMs,
    kvBound: !!env.DIARY_KV,
    avgReplyWords: cfg.avgReplyWords,
    themeBtnSize: cfg.themeBtnSize,
    landscapeBtnSize: cfg.landscapeBtnSize,
    fullscreenBtnSize: cfg.fullscreenBtnSize,
    eraserBtnSize: cfg.eraserBtnSize,
    resetBtnSize: cfg.resetBtnSize,
    whisperFontSize: cfg.whisperFontSize,
    musicUrl: cfg.musicUrl,
    footerHtml: cfg.footerHtml,
    guideHtml: cfg.guideHtml,
  };
}
