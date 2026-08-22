// Admin panel logic (Chinese UI).

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "trd_admin_token";
  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let state = null;
  let customThemes = [];

  const NUM_FIELDS = [
    "writeSpeed", "strokeWidth", "historyTurns", "catalogSize", "idleMs",
    "maxTokens", "maxReplyChars", "maxMemories", "avgReplyWords",
    "themeBtnSize", "landscapeBtnSize", "fullscreenBtnSize", "eraserBtnSize",
    "resetBtnSize", "whisperFontSize", "pressureSensitivity",
  ];
  // replyDismissMs is stored as ms but displayed as seconds
  const STR_FIELDS = ["musicUrl", "musicKey", "footerHtml", "guideHtml", "wechatVerifyName", "wechatVerifyContent"];
  const BOOL_FIELDS = ["easterEggEnabled"];

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (token) headers.Authorization = "Bearer " + token;
    const resp = await fetch(path, { ...opts, headers });
    if (resp.status === 401) { showLogin(); throw new Error("unauthorized"); }
    return resp;
  }

  function showLogin() { $("login-view").classList.remove("hidden"); $("admin-view").classList.add("hidden"); }
  function showAdmin() { $("login-view").classList.add("hidden"); $("admin-view").classList.remove("hidden"); }

  function statusLi(k, v, cls) {
    const li = document.createElement("li");
    const kEl = document.createElement("span"); kEl.className = "k"; kEl.textContent = k;
    const vEl = document.createElement("span"); vEl.className = "v " + (cls || ""); vEl.textContent = v;
    li.appendChild(kEl); li.appendChild(vEl);
    return li;
  }

  function render() {
    const cfg = state.config;
    const env = state.env;

    const sl = $("status-list");
    sl.innerHTML = "";
    sl.appendChild(statusLi("KV 存储", env.kvBound ? "已绑定" : "未绑定", env.kvBound ? "ok" : "warn"));
    sl.appendChild(statusLi("主模型 Key", env.agnesKeys ? `已配置（${env.agnesKeys} 个）` : "未配置", env.agnesKeys ? "ok" : "warn"));
    sl.appendChild(statusLi("备用模型 Key", env.zhipuKeys ? `已配置（${env.zhipuKeys} 个）` : "未配置", env.zhipuKeys ? "ok" : "warn"));
    sl.appendChild(statusLi("管理密码", env.passwordIsDefault ? "仍是默认密码" : "已修改", env.passwordIsDefault ? "warn" : "ok"));

    const ml = $("model-list");
    ml.innerHTML = "";
    ml.appendChild(statusLi("主模型", `${env.agnesModel} @ ${env.agnesBase}`));
    ml.appendChild(statusLi("备用模型", `${env.zhipuModel} @ ${env.zhipuBase}`));

    // Numeric fields
    for (const f of NUM_FIELDS) {
      const input = $("f-" + f);
      const out = $("o-" + f);
      if (!input) continue;
      input.value = String(cfg[f]);
      out.textContent = String(cfg[f]);
      input.oninput = () => { out.textContent = input.value; };
    }

    // replyDismissMs: display as seconds, store as ms
    const rdInput = $("f-replyDismissMs");
    const rdOut = $("o-replyDismissMs");
    if (rdInput) {
      rdInput.value = String(Math.round((cfg.replyDismissMs || 0) / 1000));
      rdOut.textContent = rdInput.value + " 秒";
      rdInput.oninput = () => { rdOut.textContent = rdInput.value + " 秒"; };
    }

    // String fields
    for (const f of STR_FIELDS) {
      const input = $("f-" + f);
      if (input) input.value = cfg[f] || "";
    }

    // Boolean fields
    for (const f of BOOL_FIELDS) {
      const input = $("f-" + f);
      if (input) input.checked = !!cfg[f];
    }

    // Music upload status
    const mStatus = $("music-upload-status");
    if (mStatus) {
      mStatus.textContent = cfg.musicKey ? `已上传（KV key: ${cfg.musicKey}）` : "";
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
      const sw = document.createElement("div"); sw.className = "sw"; sw.style.background = t.paper;
      const dot = document.createElement("span");
      dot.style.cssText = "position:absolute;inset:0;margin:auto;width:8px;height:8px;border-radius:50%;background:" + t.ink;
      sw.appendChild(dot);
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = t.name;
      const del = document.createElement("button"); del.textContent = "删除";
      del.onclick = () => { customThemes.splice(i, 1); renderThemes(); };
      item.appendChild(sw); item.appendChild(nm); item.appendChild(del);
      box.appendChild(item);
    });
  }

  function collectPatch() {
    const patch = {};
    for (const f of NUM_FIELDS) {
      const input = $("f-" + f);
      if (input) patch[f] = Number(input.value);
    }
    // replyDismissMs: convert seconds to ms
    const rdInput = $("f-replyDismissMs");
    if (rdInput) patch.replyDismissMs = Number(rdInput.value) * 1000;

    for (const f of STR_FIELDS) {
      const input = $("f-" + f);
      if (input) patch[f] = input.value;
    }
    for (const f of BOOL_FIELDS) {
      const input = $("f-" + f);
      if (input) patch[f] = input.checked;
    }
    patch.themes = customThemes;
    return patch;
  }

  // Events
  $("login-btn").addEventListener("click", async () => {
    const pw = $("login-password").value;
    $("login-error").textContent = "";
    try {
      const resp = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();
      if (data.ok && data.token) {
        token = data.token;
        sessionStorage.setItem(TOKEN_KEY, token);
        await load();
      } else { $("login-error").textContent = data.error || "密码不正确"; }
    } catch { $("login-error").textContent = "网络错误"; }
  });
  $("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });

  $("logout-btn").addEventListener("click", () => {
    token = ""; sessionStorage.removeItem(TOKEN_KEY); showLogin();
  });

  $("add-theme-btn").addEventListener("click", () => {
    const name = $("nt-name").value.trim();
    if (!name) { $("nt-name").focus(); return; }
    if (customThemes.length >= 12) { alert("最多 12 个自定义主题"); return; }
    customThemes.push({ name, paper: $("nt-paper").value, ink: $("nt-ink").value });
    $("nt-name").value = "";
    renderThemes();
  });

  // Music file upload
  const musicInput = $("music-file-input");
  if (musicInput) {
    musicInput.addEventListener("change", async () => {
      const file = musicInput.files && musicInput.files[0];
      if (!file) return;
      const status = $("music-upload-status");
      status.textContent = "上传中…";
      try {
        const fd = new FormData();
        fd.append("file", file, file.name);
        const resp = await fetch("/api/upload", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          body: fd,
        });
        const data = await resp.json();
        if (data.ok) {
          // Store the key in the musicKey field
          const keyInput = $("f-musicKey");
          if (keyInput) keyInput.value = data.key;
          status.textContent = `上传成功：${data.name}（${Math.round(data.size / 1024)} KB）`;
          status.className = "hint";
          status.style.color = "#2e7d32";
        } else {
          status.textContent = "上传失败：" + (data.error || "未知错误");
          status.style.color = "#c94f3d";
        }
      } catch (e) {
        status.textContent = "上传失败：" + e.message;
        status.style.color = "#c94f3d";
      }
    });
  }

  $("save-btn").addEventListener("click", async () => {
    const msg = $("save-msg");
    msg.textContent = "保存中…";
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(collectPatch()) });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        state.config = data.config;
        msg.textContent = "已保存 ✓（前台刷新后生效）";
      } else { msg.textContent = data.error || "保存失败"; }
    } catch { msg.textContent = ""; }
    setTimeout(() => (msg.textContent = ""), 4000);
  });

  $("reset-btn").addEventListener("click", async () => {
    if (!confirm("确定恢复所有参数的默认值吗？")) return;
    const patch = { ...state.defaults, themes: [] };
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(patch) });
      const data = await resp.json();
      if (resp.ok && data.ok) { state.config = data.config; render(); $("save-msg").textContent = "已恢复 ✓"; setTimeout(() => ($("save-msg").textContent = ""), 3000); }
      else { alert(data.error || "操作失败"); }
    } catch { /* unauthorized */ }
  });

  $("forget-btn").addEventListener("click", async () => {
    if (!confirm("确定清空所有会话记忆吗？此操作不可恢复。")) return;
    try {
      const resp = await api("/api/admin/forget", { method: "POST" });
      const data = await resp.json();
      if (resp.ok) alert(`已清空 ${data.deleted || 0} 份会话记忆。`);
      else alert(data.error || "操作失败");
    } catch { /* ignore */ }
  });

  async function load() {
    const resp = await api("/api/admin/state");
    state = await resp.json();
    render();
    showAdmin();
  }

  if (token) { load().catch(() => showLogin()); } else { showLogin(); }
})();
