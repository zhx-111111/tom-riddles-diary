// Runtime configuration: compile-time defaults (injected into the CF console
// as Worker vars by wrangler.jsonc), merged with overrides the admin panel
// stores in KV under the key "config".

export const DEFAULT_ADMIN_PASSWORD = "tomriddle1943";

/// Parameters the admin panel can change. Values here are the factory
/// defaults; several mirror the original riddle project's behavior
/// (2.8 s pen-rest commit, 6 recent pages carried into each request,
/// 2000-token runaway guard, ~400 remembered pages).
export const DEFAULT_CONFIG = {
  writeSpeed: 55,     // ms per character of Tom's hand (model reply writing speed)
  strokeWidth: 1.0,   // 0.5 – 2.0, scales pen radius and reply weight (笔迹粗细)
  historyTurns: 6,    // recent pages carried into each request (保留历史对话轮数)
  catalogSize: 10,    // remembered pages listed for "show me…" conjuring
  idleMs: 2800,       // pen rest before the diary drinks the ink
  maxTokens: 2000,    // runaway guard on the reply
  maxReplyChars: 600, // 单次输出长度: most characters Tom writes on one page
  maxMemories: 400,   // oldest pages beyond this are forgotten
  themes: [],         // custom themes: {id, name, paper, ink}
};

/// Built-in letter papers. "Midnight Ink" (pure black paper, cream ink) is
/// required; "Marauder's Map" and "Aged Letter" round out the set. Custom
/// themes from the admin panel are appended.
export const BUILTIN_THEMES = [
  { id: "midnight", name: "Midnight Ink",     paper: "#000000", ink: "#f2ead8", texture: "midnight" },
  { id: "map",      name: "Marauder's Map",   paper: "#d9c69c", ink: "#43301c", texture: "map" },
  { id: "aged",     name: "Aged Letter",      paper: "#e8d5a3", ink: "#241812", texture: "aged" },
];

const NUM_FIELDS = ["writeSpeed", "strokeWidth", "historyTurns", "catalogSize", "idleMs", "maxTokens", "maxReplyChars", "maxMemories"];

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
    if (Array.isArray(overrides.themes)) {
      cfg.themes = overrides.themes
        .filter((t) => t && typeof t.name === "string" && /^#[0-9a-fA-F]{6}$/.test(t.paper || "") && /^#[0-9a-fA-F]{6}$/.test(t.ink || ""))
        .slice(0, 12)
        .map((t, i) => ({ id: "c" + i, name: t.name.slice(0, 24), paper: t.paper, ink: t.ink, texture: "plain" }));
    }
  }
  cfg.writeSpeed = clampNum(cfg.writeSpeed, 10, 200, DEFAULT_CONFIG.writeSpeed);
  cfg.strokeWidth = clampNum(cfg.strokeWidth, 0.5, 2.0, DEFAULT_CONFIG.strokeWidth);
  cfg.historyTurns = Math.round(clampNum(cfg.historyTurns, 0, 20, DEFAULT_CONFIG.historyTurns));
  cfg.catalogSize = Math.round(clampNum(cfg.catalogSize, 0, 30, DEFAULT_CONFIG.catalogSize));
  cfg.idleMs = clampNum(cfg.idleMs, 800, 8000, DEFAULT_CONFIG.idleMs);
  cfg.maxTokens = Math.round(clampNum(cfg.maxTokens, 256, 8192, DEFAULT_CONFIG.maxTokens));
  cfg.maxReplyChars = Math.round(clampNum(cfg.maxReplyChars, 100, 3000, DEFAULT_CONFIG.maxReplyChars));
  cfg.maxMemories = Math.round(clampNum(cfg.maxMemories, 10, 400, DEFAULT_CONFIG.maxMemories));
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

/// Collapse whitespace to single spaces and cap at `max` chars — a catalog
/// gist must never carry its own newline (port of one_line in memory.rs).
export function oneLine(s, max) {
  return (s || "").split(/\s+/).filter(Boolean).join(" ").slice(0, max);
}

/// "the 6th of July, in the evening" — how the diary speaks of a moment.
/// Port of spoken_date in memory.rs; tzHours nudges the date (RIDDLE_TZ_OFFSET).
export function spokenDate(idSec, tzHours) {
  const t = idSec + Math.round((tzHours || 0) * 3600);
  const days = Math.floor(t / 86400);
  const hour = Math.floor(((t % 86400) + 86400) % 86400 / 3600);
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - doe / 1460 + doe / 36524 - doe / 146096) / 365);
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
  };
}
