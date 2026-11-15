// StreamClip Pro — popup: the quick controls. Everything else lives in the
// dashboard.

const { send, el, statusPill, localStatus, driveStatus, openDashboard } = ScpUI;
const $ = sel => document.querySelector(sel);

let settings = null;
let currentTab = null;
let cards = null;
let errorTimer = null;

function showError(text) {
  const node = $("#error");
  clearTimeout(errorTimer);
  node.hidden = !text;
  node.textContent = text || "";
  if (text) errorTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

async function refresh() {
  const res = await send({ type: "get-sessions" });
  const sessions = (res && res.sessions) || [];
  cards.render(sessions);
  renderCurrentTab(sessions);
  $("#empty").hidden = sessions.length > 0;
  $("#clip-all").hidden = sessions.length < 2;

  const adLive = sessions.filter(s => s.stats && s.stats.inAdBreak).length;
  $("#brand-sub").textContent = sessions.length === 0
    ? "Replay buffer idle"
    : `${sessions.length} stream${sessions.length > 1 ? "s" : ""} buffering` +
      (adLive ? ` · ${adLive} in ad break` : "");
}

function renderCurrentTab(sessions) {
  const box = $("#current-tab");
  const monitorable = currentTab && /^https?:/.test(currentTab.url || "");
  if (!monitorable || sessions.some(s => s.tabId === currentTab.id)) {
    box.hidden = true;
    return;
  }
  const site = scpSiteFromUrl(currentTab.url);
  $("#current-site").textContent = site;
  $("#current-site").dataset.site = site;
  $("#current-title").textContent = scpStreamerFromTab(currentTab.url, currentTab.title);
  box.hidden = false;
}

function renderAutomation() {
  $("#auto-switch").checked = settings.autoClipEnabled;
  $("#auto-desc").textContent = settings.autoClipEnabled
    ? `On — every ${scpFormatDuration(scpAutoClipSeconds(settings))}, each stream is saved`
    : "Off — clips are saved only when you ask";
}

async function renderDrive() {
  const res = await send({ type: "drive-status" });
  const pill = $("#drive-pill");
  const status = res && res.status;
  if (!status || !status.enabled) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.dataset.state = status.connected ? "ok" : "warn";
  pill.textContent = status.connected ? "☁ Drive on" : "☁ Drive not connected";
  pill.title = status.connected
    ? `Every clip is uploaded to Google Drive${status.account && status.account.email ? " (" + status.account.email + ")" : ""}`
    : "Drive upload is enabled but not connected — open the dashboard to connect.";
}

async function renderRecent() {
  const { clipHistory = [] } = await chrome.storage.local.get("clipHistory");
  const list = $("#recent-list");
  list.textContent = "";
  $("#recent").hidden = clipHistory.length === 0;
  for (const clip of clipHistory.slice(0, 3)) {
    const drive = driveStatus(clip);
    const row = el("div", { class: "recent-item" }, [
      el("span", { class: "site-chip", dataset: { site: clip.site }, text: clip.site }),
      el("span", { class: "who", text: clip.streamer, title: clip.filename || "" }),
      el("span", { class: "meta", text: `${scpFormatDuration(clip.lengthSeconds)} · ${scpFormatBytes(clip.sizeBytes)}` }),
      clip.drive && clip.drive !== "off"
        ? statusPill(drive, clip.driveError || "")
        : statusPill(localStatus(clip), clip.localError || "")
    ]);
    if (clip.downloadId != null && clip.local !== "off") {
      row.append(el("button", {
        class: "icon-btn", type: "button", title: "Show file", "aria-label": "Show file",
        text: "📂", onclick: () => chrome.downloads.show(clip.downloadId)
      }));
    }
    list.append(row);
  }
}

async function startMonitoring(auto) {
  const btn = $("#start-current");
  btn.disabled = true;
  btn.textContent = "Starting…";
  const res = await send({ type: "start-capture", tabId: currentTab.id, auto });
  btn.disabled = false;
  btn.textContent = "Start monitoring";
  if (!auto && (!res || (!res.ok && !res.suppressed))) {
    showError((res && res.error) || "Could not start capture.");
  }
  refresh();
}

async function init() {
  settings = await scpLoadSettings();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  cards = ScpStreamCards({
    container: $("#sessions"),
    getSettings: () => settings,
    onError: showError,
    onChanged: refresh
  });

  $("#start-current").addEventListener("click", () => startMonitoring(false));
  $("#clip-all").addEventListener("click", () =>
    send({ type: "clip-all", durationSeconds: settings.defaultClipSeconds }));
  $("#open-dashboard").addEventListener("click", () => openDashboard("live"));
  $("#open-library").addEventListener("click", () => openDashboard("library"));
  $("#auto-switch").addEventListener("change", async ev => {
    settings.autoClipEnabled = ev.target.checked;
    await scpSaveSettings(settings);
    renderAutomation();
    refresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.clipHistory) renderRecent();
  });

  renderAutomation();
  renderDrive();
  renderRecent();
  await refresh();
  const timer = setInterval(refresh, 2000);
  window.addEventListener("unload", () => clearInterval(timer));

  // Opening the popup on a live stream page starts the buffer right away
  // (opt-out in the dashboard; suppressed after a manual stop).
  if (settings.autoStartOnPopupOpen && currentTab && scpIsLikelyStreamPage(currentTab.url || "")) {
    const res = await send({ type: "get-sessions" });
    const monitored = res && res.sessions && res.sessions.some(s => s.tabId === currentTab.id);
    if (!monitored) await startMonitoring(true);
  }
}

init();
