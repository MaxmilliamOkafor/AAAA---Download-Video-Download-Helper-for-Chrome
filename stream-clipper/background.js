// StreamClip Pro — background service worker.
// Owns the session registry, routes work to the offscreen capture document,
// and turns finished clips into downloads + notifications.

importScripts("shared/settings.js", "shared/hls-parse.js");

const OFFSCREEN_URL = "offscreen/offscreen.html";

// MV3 terminates this service worker after ~30s idle, which would wipe any
// plain in-memory state while the offscreen document keeps recording. All
// cross-invocation state therefore lives in chrome.storage.session, with
// these Maps acting only as a warm cache for the current invocation.

// tabId -> { tabId, title, url, site, streamer, startedAt, status, mode, lastError }
const sessions = new Map();
// downloadId -> objectUrl (revoked in offscreen once the download finishes)
const pendingDownloads = new Map();
// Tabs the user explicitly stopped — auto-start won't re-arm them until navigation.
const manualStops = new Set();
// tabId -> { url, seenAt } — the newest HLS playlist the tab requested.
const playlistsByTab = new Map();

const HISTORY_LIMIT = 50;
const PLAYLIST_TTL_MS = 5 * 60 * 1000;

let hydrated = false;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const stored = await chrome.storage.session.get(["sessions", "playlists", "manualStops"]);
  for (const [k, v] of Object.entries(stored.playlists || {})) playlistsByTab.set(Number(k), v);
  for (const id of stored.manualStops || []) manualStops.add(id);
  for (const [k, v] of Object.entries(stored.sessions || {})) sessions.set(Number(k), v);

  // The offscreen document is the authority on what is actually recording.
  // Reconcile against it so a restarted worker neither forgets live captures
  // nor advertises dead ones.
  if (sessions.size > 0) {
    const live = await chrome.runtime
      .sendMessage({ target: "offscreen", type: "list-captures" })
      .catch(() => null);
    if (live && live.ok) {
      const liveIds = new Set(live.tabIds);
      for (const tabId of [...sessions.keys()]) {
        if (!liveIds.has(tabId)) sessions.delete(tabId);
      }
    } else {
      // No offscreen document means nothing is recording.
      sessions.clear();
    }
    await persistSessions();
    updateBadge();
  }
}

async function persistSessions() {
  await chrome.storage.session.set({ sessions: Object.fromEntries(sessions) });
}

async function persistPlaylists() {
  await chrome.storage.session.set({ playlists: Object.fromEntries(playlistsByTab) });
}

async function persistManualStops() {
  await chrome.storage.session.set({ manualStops: [...manualStops] });
}

// Watch for the stream's own HLS playlist so we can buffer original segments
// instead of re-encoding the rendered tab. Observation only — nothing is
// blocked, redirected or modified.
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (!/\.m3u8(\?|$)/i.test(url)) return;
    const existing = playlistsByTab.get(details.tabId);
    // Prefer a master playlist (it lists every quality) over a rendition one.
    const isMasterish = /master|playlist/i.test(url);
    if (existing && !isMasterish && Date.now() - existing.seenAt < 30_000) return;
    playlistsByTab.set(details.tabId, { url, seenAt: Date.now() });
    persistPlaylists().catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] }
);

async function getPlaylistForTab(tabId) {
  let entry = playlistsByTab.get(tabId);
  if (!entry) {
    // A restarted worker may not have seen the request itself.
    const { playlists = {} } = await chrome.storage.session.get("playlists");
    entry = playlists[tabId];
    if (entry) playlistsByTab.set(tabId, entry);
  }
  if (!entry) return null;
  if (Date.now() - entry.seenAt > PLAYLIST_TTL_MS) return null;
  return entry.url;
}

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

async function startCapture(tabId, { auto = false } = {}) {
  if (sessions.has(tabId)) {
    return { ok: false, error: "This tab is already being monitored." };
  }
  if (auto && manualStops.has(tabId)) {
    return { ok: false, error: "auto-start suppressed (stopped manually)", suppressed: true };
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !/^https?:/.test(tab.url || "")) {
    return { ok: false, error: "Open the stream in a normal web tab first." };
  }

  const settings = await scpLoadSettings();
  await ensureOffscreenDocument();

  const meta = {
    tabId,
    title: tab.title || "",
    url: tab.url || "",
    site: scpSiteFromUrl(tab.url || ""),
    streamer: scpStreamerFromTab(tab.url || "", tab.title || ""),
    startedAt: Date.now(),
    status: "starting",
    mode: null,
    lastError: null
  };
  sessions.set(tabId, meta);
  await persistSessions();
  updateBadge();

  const playlistUrl = await getPlaylistForTab(tabId);
  const wantSource = settings.captureMode !== "tab" && !!playlistUrl;
  let res = null;

  // Preferred path: buffer the broadcaster's original segments (no re-encode).
  if (wantSource) {
    res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start-source-capture",
      tabId,
      playlistUrl,
      settings
    }).catch(e => ({ ok: false, error: e.message }));
    if (res && res.ok) {
      meta.status = "recording";
      meta.mode = "source";
      meta.quality = res.quality || null;
      await persistSessions();
      updateBadge();
      return { ok: true, mode: "source", quality: res.quality };
    }
  }

  // Source mode was requested explicitly but unavailable — say so rather than
  // silently downgrading the quality the user asked for.
  if (settings.captureMode === "source") {
    sessions.delete(tabId);
    await persistSessions();
    updateBadge();
    await maybeCloseOffscreen();
    const why = playlistUrl
      ? (res && res.error) || "could not read the stream playlist"
      : "no stream playlist seen on this tab yet — start playback, then try again";
    return { ok: false, error: `Source-quality capture unavailable: ${why}.` };
  }

  // Universal fallback: record what the tab renders.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-capture",
    tabId,
    streamId,
    settings
  }).catch(e => ({ ok: false, error: e.message }));

  if (!res || !res.ok) {
    sessions.delete(tabId);
    await persistSessions();
    updateBadge();
    await maybeCloseOffscreen();
    return { ok: false, error: (res && res.error) || "Could not start capture." };
  }
  meta.status = "recording";
  meta.mode = "tab";
  meta.mimeType = res.mimeType;
  updateBadge();
  return { ok: true, mode: "tab" };
}

async function stopCapture(tabId, { silent = false, byUser = false } = {}) {
  if (!sessions.has(tabId)) return { ok: true };
  if (byUser) {
    manualStops.add(tabId);
    await persistManualStops();
  }
  await chrome.runtime
    .sendMessage({ target: "offscreen", type: "stop-capture", tabId })
    .catch(() => {});
  sessions.delete(tabId);
  await persistSessions();
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
    durationSeconds: dur,
    postRollSeconds: settings.postRollSeconds
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
    await recordClipHistory({
      downloadId,
      filename,
      site: session.site || "Stream",
      streamer: session.streamer || "stream",
      lengthSeconds: msg.lengthSeconds,
      sizeBytes: msg.sizeBytes,
      time: Date.now()
    });
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

async function recordClipHistory(entry) {
  const { clipHistory = [] } = await chrome.storage.local.get("clipHistory");
  clipHistory.unshift(entry);
  if (clipHistory.length > HISTORY_LIMIT) clipHistory.length = HISTORY_LIMIT;
  await chrome.storage.local.set({ clipHistory });
}

// Clicking a "Clip saved" notification reveals the file in the file manager.
chrome.notifications.onClicked.addListener(id => {
  const m = /^clip-(\d+)$/.exec(id);
  if (m) chrome.downloads.show(Number(m[1]));
  chrome.notifications.clear(id);
});

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
  await persistSessions();
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
    await hydrate();
    switch (msg.type) {
      case "start-capture":
        sendResponse(await startCapture(msg.tabId, { auto: !!msg.auto }));
        break;
      case "stop-capture":
        sendResponse(await stopCapture(msg.tabId, { byUser: true }));
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
  await hydrate();
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
    return;
  }
  if (command === "toggle-monitor") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    if (sessions.has(tab.id)) {
      await stopCapture(tab.id, { byUser: true });
    } else {
      await startCapture(tab.id);
    }
  }
});

// Keep session titles fresh and drop sessions whose tabs disappear.
chrome.tabs.onRemoved.addListener(async tabId => {
  await hydrate();
  manualStops.delete(tabId);
  playlistsByTab.delete(tabId);
  await Promise.all([persistManualStops(), persistPlaylists()]);
  if (sessions.has(tabId)) await stopCapture(tabId, { silent: true });
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && !changeInfo.title) return;
  await hydrate();
  if (changeInfo.url) {
    // New page — auto-start may apply again, and the old playlist is stale.
    manualStops.delete(tabId);
    playlistsByTab.delete(tabId);
    await Promise.all([persistManualStops(), persistPlaylists()]);
  }
  const s = sessions.get(tabId);
  if (s && changeInfo.title) {
    s.title = changeInfo.title;
    await persistSessions();
  }
});

updateBadge();
