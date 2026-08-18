// Admin panel logic (Chinese UI). Password login → 12h token; config edits
// are saved to KV via the worker. Model endpoints & keys live in CF console
// environment variables and are shown read-only here.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "trd_admin_token";
  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let state = null;
  let customThemes = [];

  const NUM_FIELDS = ["writeSpeed", "strokeWidth", "historyTurns", "catalogSize", "idleMs", "maxTokens", "maxMemories"];

  // ------------------------------------------------------------- api calls

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (token) headers.Authorization = "Bearer " + token;
    const resp = await fetch(path, { ...opts, headers });
    if (resp.status === 401) { showLogin(); throw new Error("unauthorized"); }
    return resp;
  }

  function showLogin() {
    $("login-view").classList.remove("hidden");
    $("admin-view").classList.add("hidden");
  }

  function showAdmin() {
    $("login-view").classList.add("hidden");
    $("admin-view").classList.remove("hidden");
  }

  // --------------------------------------------------------------- render

  function statusLi(k, v, cls) {
    const li = document.createElement("li");
    const kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "v " + (cls || "");
    vEl.textContent = v;
    li.appendChild(kEl);
    li.appendChild(vEl);
    return li;
  }

  function render() {
    const cfg = state.config;
    const env = state.env;

    // status
    const sl = $("status-list");
    sl.innerHTML = "";
    sl.appendChild(statusLi("KV 存储（DIARY_KV）", env.kvBound ? "已绑定" : "未绑定 — 请在 CF 控制台绑定 KV，否则记忆与配置无法持久保存", env.kvBound ? "ok" : "warn"));
    sl.appendChild(statusLi("主模型 API Key", env.agnesKeys ? `已配置（${env.agnesKeys} 个，轮转调用）` : "未配置", env.agnesKeys ? "ok" : "warn"));
    sl.appendChild(statusLi("备用视觉模型 Key", env.zhipuKeys ? `已配置（${env.zhipuKeys} 个）` : "未配置（降级与誊写功能不可用）", env.zhipuKeys ? "ok" : "warn"));
    sl.appendChild(statusLi("管理密码", env.passwordIsDefault ? "仍是默认密码，建议修改环境变量 ADMIN_PASSWORD" : "已修改", env.passwordIsDefault ? "warn" : "ok"));

    // model info
    const ml = $("model-list");
    ml.innerHTML = "";
    ml.appendChild(statusLi("主模型", `${env.agnesModel} @ ${env.agnesBase}`));
    ml.appendChild(statusLi("备用模型（视觉）", `${env.zhipuModel} @ ${env.zhipuBase}`));

    // fields
    for (const f of NUM_FIELDS) {
      const input = $("f-" + f);
      const out = $("o-" + f);
      if (!input) continue;
      input.value = String(cfg[f]);
      out.textContent = String(cfg[f]);
      input.oninput = () => { out.textContent = input.value; };
    }

    customThemes = (cfg.themes || []).map((t) => ({ name: t.name, paper: t.paper, ink: t.ink }));
    renderThemes();
  }

  function renderThemes() {
    const box = $("custom-themes");
    box.innerHTML = "";
    customThemes.forEach((t, i) => {
      const item = document.createElement("div");
      item.className = "theme-item";
      const sw = document.createElement("div");
      sw.className = "sw";
      sw.style.background = t.paper;
      const dot = document.createElement("span");
      dot.style.cssText = "position:absolute;inset:0;margin:auto;width:8px;height:8px;border-radius:50%;background:" + t.ink;
      sw.appendChild(dot);
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = t.name;
      const del = document.createElement("button");
      del.textContent = "删除";
      del.onclick = () => { customThemes.splice(i, 1); renderThemes(); };
      item.appendChild(sw);
      item.appendChild(nm);
      item.appendChild(del);
      box.appendChild(item);
    });
  }

  function collectPatch() {
    const patch = {};
    for (const f of NUM_FIELDS) {
      const input = $("f-" + f);
      if (input) patch[f] = Number(input.value);
    }
    patch.themes = customThemes;
    return patch;
  }

  // --------------------------------------------------------------- events

  $("login-btn").addEventListener("click", async () => {
    const pw = $("login-password").value;
    $("login-error").textContent = "";
    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();
      if (data.ok && data.token) {
        token = data.token;
        sessionStorage.setItem(TOKEN_KEY, token);
        await load();
      } else {
        $("login-error").textContent = data.error || "密码不正确";
      }
    } catch {
      $("login-error").textContent = "网络错误，请重试";
    }
  });
  $("login-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("login-btn").click();
  });

  $("logout-btn").addEventListener("click", () => {
    token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    showLogin();
  });

  $("add-theme-btn").addEventListener("click", () => {
    const name = $("nt-name").value.trim();
    if (!name) { $("nt-name").focus(); return; }
    if (customThemes.length >= 12) { alert("最多 12 个自定义主题"); return; }
    customThemes.push({ name, paper: $("nt-paper").value, ink: $("nt-ink").value });
    $("nt-name").value = "";
    renderThemes();
  });

  $("save-btn").addEventListener("click", async () => {
    const msg = $("save-msg");
    msg.textContent = "保存中…";
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(collectPatch()) });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        state.config = data.config;
        msg.textContent = "已保存 ✓（前台刷新后生效）";
      } else {
        msg.textContent = data.error || "保存失败";
      }
    } catch {
      msg.textContent = "";
    }
    setTimeout(() => (msg.textContent = ""), 4000);
  });

  $("reset-btn").addEventListener("click", async () => {
    if (!confirm("确定恢复所有参数的默认值吗？")) return;
    const patch = { ...state.defaults, themes: [] };
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(patch) });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        state.config = data.config;
        render();
        $("save-msg").textContent = "已恢复默认值 ✓";
        setTimeout(() => ($("save-msg").textContent = ""), 3000);
      } else {
        alert(data.error || "操作失败");
      }
    } catch { /* unauthorized → already back at login */ }
  });

  $("forget-btn").addEventListener("click", async () => {
    if (!confirm("确定清空所有会话的记忆吗？此操作不可恢复。")) return;
    try {
      const resp = await api("/api/admin/forget", { method: "POST" });
      const data = await resp.json();
      if (resp.ok) alert(`已清空 ${data.deleted || 0} 份会话记忆。`);
      else alert(data.error || "操作失败");
    } catch { /* ignore */ }
  });

  // ----------------------------------------------------------------- boot

  async function load() {
    const resp = await api("/api/admin/state");
    state = await resp.json();
    render();
    showAdmin();
  }

  if (token) {
    load().catch(() => showLogin());
  } else {
    showLogin();
  }
})();
