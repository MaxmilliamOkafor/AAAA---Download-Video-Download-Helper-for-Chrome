// StreamClip Pro — popup controller.

let settings = null;
let currentTab = null;
let refreshTimer = null;

const $ = sel => document.querySelector(sel);

function send(msg) {
  return chrome.runtime.sendMessage({ target: "background", ...msg });
}

function showError(text) {
  const el = $("#error");
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 6000);
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function fmtBytes(bytes) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

async function refresh() {
  const res = await send({ type: "get-sessions" }).catch(() => null);
  const sessions = (res && res.sessions) || [];
  renderSessions(sessions);
  renderCurrentTab(sessions);
  $("#empty").hidden = sessions.length > 0;
  $("#clip-all").hidden = sessions.length < 2;
}

function renderCurrentTab(sessions) {
  const box = $("#current-tab");
  if (!currentTab || !/^https?:/.test(currentTab.url || "")) { box.hidden = true; return; }
  const monitored = sessions.some(s => s.tabId === currentTab.id);
  if (monitored) { box.hidden = true; return; }
  const site = scpSiteFromUrl(currentTab.url);
  const chip = $("#current-site");
  chip.textContent = site;
  chip.dataset.site = site;
  $("#current-title").textContent = scpStreamerFromTab(currentTab.url, currentTab.title);
  box.hidden = false;
}

function renderSessions(sessions) {
  const container = $("#sessions");
  container.textContent = "";
  const tpl = $("#session-template");

  for (const s of sessions) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const chip = node.querySelector(".site-chip");
    chip.textContent = s.site;
    chip.dataset.site = s.site;
    node.querySelector(".session-name").textContent = s.streamer || s.title || "Stream";
    node.querySelector(".session-name").title = s.title || "";

    const stats = s.stats;
    const info = node.querySelector(".buffer-info");
    if (stats) {
      info.textContent =
        `Buffer: ${fmtDuration(stats.bufferedSeconds)} / ${fmtDuration(stats.maxBufferSeconds)}` +
        ` · ${fmtBytes(stats.bufferedBytes)} · since ${new Date(stats.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const pct = Math.min(100, (stats.bufferedSeconds / stats.maxBufferSeconds) * 100);
      node.querySelector(".buffer-fill").style.width = `${pct}%`;
    } else {
      info.textContent = "Buffer warming up…";
    }

    const btnBox = node.querySelector(".clip-buttons");
    for (const preset of settings.clipPresets) {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = fmtDuration(preset);
      b.title = `Save the last ${fmtDuration(preset)} of this stream`;
      b.addEventListener("click", () => doClip(s.tabId, preset, b));
      btnBox.appendChild(b);
    }

    const customRow = node.querySelector(".custom-row");
    if (!settings.customClipEnabled) {
      customRow.hidden = true;
    } else {
      customRow.querySelector(".custom-clip").addEventListener("click", () => {
        const min = parseInt(customRow.querySelector(".custom-min").value, 10) || 0;
        const sec = parseInt(customRow.querySelector(".custom-sec").value, 10) || 0;
        const total = min * 60 + sec;
        if (total < 5) { showError("Custom clip length must be at least 5 seconds."); return; }
        doClip(s.tabId, total, customRow.querySelector(".custom-clip"));
      });
    }

    node.querySelector(".stop").addEventListener("click", async () => {
      await send({ type: "stop-capture", tabId: s.tabId });
      refresh();
    });

    container.appendChild(node);
  }
}

async function doClip(tabId, seconds, button) {
  const res = await send({ type: "make-clip", tabId, durationSeconds: seconds }).catch(e => ({ ok: false, error: e.message }));
  if (!res || !res.ok) {
    showError((res && res.error) || "Clip failed.");
    return;
  }
  if (button) {
    const original = button.textContent;
    button.classList.add("flash");
    button.textContent = "✓ Saved";
    setTimeout(() => { button.classList.remove("flash"); button.textContent = original; }, 1600);
  }
}

async function init() {
  settings = await scpLoadSettings();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $("#start-current").addEventListener("click", async () => {
    const btn = $("#start-current");
    btn.disabled = true;
    btn.textContent = "Starting…";
    const res = await send({ type: "start-capture", tabId: currentTab.id }).catch(e => ({ ok: false, error: e.message }));
    btn.disabled = false;
    btn.textContent = "● Start monitoring";
    if (!res || !res.ok) showError((res && res.error) || "Could not start capture.");
    refresh();
  });

  $("#clip-all").addEventListener("click", async () => {
    const res = await send({ type: "clip-all", durationSeconds: settings.defaultClipSeconds });
    if (res && res.ok) showError(null);
  });

  $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  await refresh();
  refreshTimer = setInterval(refresh, 2000);
}

window.addEventListener("unload", () => clearInterval(refreshTimer));
init();
