// StreamClip Pro — background service worker.
// Owns the session registry, routes work to the offscreen capture document,
// and turns finished clips into downloads + notifications.

importScripts("shared/settings.js");

const OFFSCREEN_URL = "offscreen/offscreen.html";

// tabId -> { tabId, title, url, site, streamer, startedAt, status, lastError }
const sessions = new Map();
// downloadId -> objectUrl (revoked in offscreen once the download finishes)
const pendingDownloads = new Map();

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "BLOBS"],
        justification:
          "Records tab audio/video into a rolling replay buffer so the user can save clips of live streams they are watching."
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function maybeCloseOffscreen() {
  if (sessions.size === 0 && pendingDownloads.size === 0) {
    try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
  }
}

function updateBadge() {
  const active = [...sessions.values()].filter(s => s.status === "recording").length;
  chrome.action.setBadgeText({ text: active > 0 ? String(active) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    silent: true
  });
}

async function startCapture(tabId) {
  if (sessions.has(tabId)) {
    return { ok: false, error: "This tab is already being monitored." };
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !/^https?:/.test(tab.url || "")) {
    return { ok: false, error: "Open the stream in a normal web tab first." };
  }

  const settings = await scpLoadSettings();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();

  const meta = {
    tabId,
    title: tab.title || "",
    url: tab.url || "",
    site: scpSiteFromUrl(tab.url || ""),
    streamer: scpStreamerFromTab(tab.url || "", tab.title || ""),
    startedAt: Date.now(),
    status: "starting",
    lastError: null
  };
  sessions.set(tabId, meta);
  updateBadge();

  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-capture",
    tabId,
    streamId,
    settings
  }).catch(e => ({ ok: false, error: e.message }));

  if (!res || !res.ok) {
    sessions.delete(tabId);
    updateBadge();
    await maybeCloseOffscreen();
    return { ok: false, error: (res && res.error) || "Could not start capture." };
  }
  meta.status = "recording";
  meta.mimeType = res.mimeType;
  updateBadge();
  return { ok: true };
}

async function stopCapture(tabId, { silent = false } = {}) {
  if (!sessions.has(tabId)) return { ok: true };
  await chrome.runtime
    .sendMessage({ target: "offscreen", type: "stop-capture", tabId })
    .catch(() => {});
  sessions.delete(tabId);
  updateBadge();
  await maybeCloseOffscreen();
  if (!silent) {
    // no notification on manual stop — the popup already reflects it
  }
  return { ok: true };
}

async function requestClip(tabId, durationSeconds) {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: "This tab isn't being monitored." };
  const settings = await scpLoadSettings();
  const dur = Math.max(5, Math.min(settings.bufferMinutes * 60, Math.round(durationSeconds || settings.defaultClipSeconds)));
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "make-clip",
    tabId,
    durationSeconds: dur
  }).catch(e => ({ ok: false, error: e.message }));
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || "Clip failed." };
  }
  return res; // download is kicked off by the clip-ready message
}

async function clipAll(durationSeconds) {
  const ids = [...sessions.keys()];
  const results = await Promise.all(ids.map(id => requestClip(id, durationSeconds)));
  return { ok: true, count: results.filter(r => r.ok).length, total: ids.length };
}

async function handleClipReady(msg) {
  // msg: { tabId, url (blob), lengthSeconds, sizeBytes, extension }
  const session = sessions.get(msg.tabId) || {};
  const settings = await scpLoadSettings();
  const filename = scpBuildFileName(settings.fileNameTemplate, {
    site: session.site,
    streamer: session.streamer,
    title: session.title,
    lengthSeconds: msg.lengthSeconds,
    extension: msg.extension,
    timestamp: Date.now()
  });
  try {
    const downloadId = await chrome.downloads.download({
      url: msg.url,
      filename,
      saveAs: settings.askWhereToSave,
      conflictAction: "uniquify"
    });
    pendingDownloads.set(downloadId, msg.url);
    if (settings.notifyOnClipSaved) {
      const mb = (msg.sizeBytes / (1024 * 1024)).toFixed(1);
      notify(
        `clip-${downloadId}`,
        "Clip saved",
        `${session.streamer || "Stream"} — last ${msg.lengthSeconds}s (${mb} MB)`
      );
    }
  } catch (e) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "release-url", url: msg.url }).catch(() => {});
    if (settings.notifyOnCaptureError) {
      notify(`cliperr-${Date.now()}`, "Clip could not be saved", e.message || String(e));
    }
  }
}

chrome.downloads.onChanged.addListener(delta => {
  if (!pendingDownloads.has(delta.id)) return;
  const state = delta.state && delta.state.current;
  if (state === "complete" || state === "interrupted") {
    const url = pendingDownloads.get(delta.id);
    pendingDownloads.delete(delta.id);
    chrome.runtime.sendMessage({ target: "offscreen", type: "release-url", url }).catch(() => {});
    maybeCloseOffscreen();
  }
});

async function handleCaptureEnded(msg) {
  // Offscreen tells us a capture died (tab closed, stream ended, error).
  const session = sessions.get(msg.tabId);
  if (!session) return;
  sessions.delete(msg.tabId);
  updateBadge();
  const settings = await scpLoadSettings();
  if (msg.error && settings.notifyOnCaptureError) {
    notify(
      `capend-${msg.tabId}-${Date.now()}`,
      "Stream capture stopped",
      `${session.streamer || "Stream"}: ${msg.error}`
    );
  }
  await maybeCloseOffscreen();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "background") return;
  (async () => {
    switch (msg.type) {
      case "start-capture":
        sendResponse(await startCapture(msg.tabId));
        break;
      case "stop-capture":
        sendResponse(await stopCapture(msg.tabId));
        break;
      case "make-clip":
        sendResponse(await requestClip(msg.tabId, msg.durationSeconds));
        break;
      case "clip-all":
        sendResponse(await clipAll(msg.durationSeconds));
        break;
      case "get-sessions": {
        const list = await Promise.all(
          [...sessions.values()].map(async s => {
            const stats = await chrome.runtime
              .sendMessage({ target: "offscreen", type: "get-stats", tabId: s.tabId })
              .catch(() => null);
            return { ...s, stats: stats && stats.ok ? stats.stats : null };
          })
        );
        sendResponse({ ok: true, sessions: list });
        break;
      }
      case "clip-ready":
        await handleClipReady(msg);
        sendResponse({ ok: true });
        break;
      case "capture-ended":
        await handleCaptureEnded(msg);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: `Unknown message: ${msg.type}` });
    }
  })();
  return true; // async response
});

// Keyboard shortcuts.
chrome.commands.onCommand.addListener(async command => {
  const settings = await scpLoadSettings();
  if (command === "clip-all-tabs") {
    await clipAll(settings.defaultClipSeconds);
    return;
  }
  if (command === "clip-active-tab") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && sessions.has(tab.id)) {
      await requestClip(tab.id, settings.defaultClipSeconds);
    } else {
      // Not on a monitored tab (e.g. you're editing in another window) — clip everything.
      await clipAll(settings.defaultClipSeconds);
    }
  }
});

// Keep session titles fresh and drop sessions whose tabs disappear.
chrome.tabs.onRemoved.addListener(tabId => {
  if (sessions.has(tabId)) stopCapture(tabId, { silent: true });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const s = sessions.get(tabId);
  if (s && changeInfo.title) s.title = changeInfo.title;
});

updateBadge();
