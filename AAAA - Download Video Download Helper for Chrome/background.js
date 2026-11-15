// StreamClip Pro — background service worker.
// Owns the session registry, routes work to the offscreen capture document,
// and turns finished clips into downloads + notifications.

importScripts("shared/settings.js", "shared/hls-parse.js", "drive-auth.js");

const OFFSCREEN_URL = "offscreen/offscreen.html";

// MV3 terminates this service worker after ~30s idle, which would wipe any
// plain in-memory state while the offscreen document keeps recording. All
// cross-invocation state therefore lives in chrome.storage.session, with
// these Maps acting only as a warm cache for the current invocation.

// tabId -> { tabId, title, url, site, streamer, startedAt, status, mode, lastError }
const sessions = new Map();
// downloadId -> { url, clipId } for local saves still in progress
const pendingDownloads = new Map();
// Tabs the user explicitly stopped — auto-start won't re-arm them until navigation.
const manualStops = new Set();
// tabId -> { url, seenAt } — the newest HLS playlist the tab requested.
const playlistsByTab = new Map();

const HISTORY_LIMIT = 200;
const AUTO_CLIP_ALARM = "scp-auto-clip";
// Sessions that just ended, kept briefly so a final clip that arrives a moment
// after its capture stopped is still named after the right streamer.
const endedSessions = new Map();

function rememberEnded(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  endedSessions.set(tabId, session);
  setTimeout(() => endedSessions.delete(tabId), 60_000);
}
const PLAYLIST_TTL_MS = 5 * 60 * 1000;

// Starts in flight, keyed by tab. The popup's auto-start and a user click can
// fire together; both must resolve to the same outcome instead of the second
// one reporting the tab as already monitored.
const startsInFlight = new Map();

let hydratePromise = null;

// Shared promise, not a boolean: concurrent callers must all wait for the
// same hydration to finish, or the later ones proceed against empty state.
function hydrate() {
  if (!hydratePromise) hydratePromise = doHydrate();
  return hydratePromise;
}

async function doHydrate() {
  const stored = await chrome.storage.session.get([
    "sessions", "playlists", "manualStops", "pendingDownloads"
  ]);
  for (const [k, v] of Object.entries(stored.pendingDownloads || {})) pendingDownloads.set(Number(k), v);
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
//
// Two URLs are kept per tab. Players request the master playlist first (it
// lists every quality) and then poll one rendition every couple of seconds,
// so `first` is the route to the best quality and `latest` is a fallback
// that is always fresh.
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0) return; // our own fetches from the offscreen document
    const url = details.url;
    if (!/\.m3u8(\?|$)/i.test(url)) return;
    const now = Date.now();
    const entry = playlistsByTab.get(details.tabId);
    if (!entry) {
      playlistsByTab.set(details.tabId, { first: { url, seenAt: now }, latest: { url, seenAt: now } });
      persistPlaylists().catch(() => {});
    } else {
      const stale = now - entry.latest.seenAt > 30_000;
      entry.latest = { url, seenAt: now };
      // Rendition polls arrive every ~2s; persisting each one is pointless.
      if (stale) persistPlaylists().catch(() => {});
    }
    maybeAutoMonitor(details.tabId).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] }
);

// Candidate playlist URLs for a tab, best first.
async function getPlaylistsForTab(tabId) {
  let entry = playlistsByTab.get(tabId);
  if (!entry) {
    // A restarted worker may not have seen the request itself.
    const { playlists = {} } = await chrome.storage.session.get("playlists");
    entry = playlists[tabId];
    if (entry) playlistsByTab.set(tabId, entry);
  }
  if (!entry || !entry.latest) return [];
  if (Date.now() - entry.latest.seenAt > PLAYLIST_TTL_MS) return [];
  return [...new Set([entry.first.url, entry.latest.url])];
}

// Hands-free start: when a live channel page begins playing, buffer it
// without waiting for a click. Only source capture can do this — recording a
// tab's pixels requires the user to invoke the extension on that tab.
const autoMonitorAttempts = new Map(); // tabId -> last attempt, to avoid retry storms

async function maybeAutoMonitor(tabId) {
  if (sessions.has(tabId) || startsInFlight.has(tabId)) return;
  await hydrate();
  if (sessions.has(tabId) || manualStops.has(tabId) || startsInFlight.has(tabId)) return;
  if (Date.now() - (autoMonitorAttempts.get(tabId) || 0) < 30_000) return;
  autoMonitorAttempts.set(tabId, Date.now());
  const settings = await scpLoadSettings();
  if (!settings.autoMonitor || settings.captureMode === "tab") return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !scpIsLiveChannelPage(tab.url || "")) return;
  await startCapture(tabId, { sourceOnly: true });
}

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "BLOBS"],
        justification:
          "Records tab audio/video into a rolling replay buffer so the user can save clips of live streams they are watching."
      })
      .catch(err => {
        // Two starts racing (or a restarted worker) can both pass the
        // hasDocument() check. A document that already exists is exactly
        // what the caller wanted, so this is success, not failure.
        if (!/single offscreen document/i.test(err && err.message)) throw err;
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

// Every capture shares one offscreen document, so closing it kills them all.
// Only close when the document itself confirms nothing is left recording —
// the registry here can lag behind, and trusting it has torn down live
// captures for other tabs.
async function maybeCloseOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) return;
  const live = await chrome.runtime
    .sendMessage({ target: "offscreen", type: "list-captures" })
    .catch(() => null);
  if (live && live.ok && live.tabIds.length > 0) return;
  // Clips still downloading, uploading to Drive or being assembled live there.
  if (live && live.ok && live.busy > 0) return;
  if (sessions.size > 0) return;
  try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

// Injects the player locator and waits briefly for its first report, so the
// crop is known before recording starts rather than a second into the clip.
async function injectVideoLocator(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/video-locator.js"]
    });
  } catch (e) {
    return; // restricted page, or no host access — fall back to full-tab
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const geometry = await chrome.runtime
      .sendMessage({ target: "offscreen", type: "peek-rect", tabId })
      .catch(() => null);
    if (geometry && geometry.ok && geometry.has) return;
    await new Promise(r => setTimeout(r, 150));
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

function startCapture(tabId, opts = {}) {
  // Collapse concurrent starts for the same tab onto one attempt.
  const inFlight = startsInFlight.get(tabId);
  if (inFlight) return inFlight;
  const attempt = doStartCapture(tabId, opts).finally(() => startsInFlight.delete(tabId));
  startsInFlight.set(tabId, attempt);
  return attempt;
}

async function doStartCapture(tabId, { auto = false, sourceOnly = false } = {}) {
  if (sessions.has(tabId)) {
    // Already running is the state the caller asked for — not an error.
    const s = sessions.get(tabId);
    return { ok: true, already: true, mode: s.mode, quality: s.quality };
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

  const playlistUrls = await getPlaylistsForTab(tabId);
  const playlistUrl = playlistUrls[0] || null;
  const wantSource = settings.captureMode !== "tab" && !!playlistUrl;
  let res = null;

  // Preferred path: buffer the broadcaster's original segments (no re-encode).
  if (wantSource) {
    res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start-source-capture",
      tabId,
      playlistUrls,
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
  if (settings.captureMode === "source" || sourceOnly) {
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
  // Locate the player first so the capture can be cropped to the video alone.
  if (settings.cropToVideo) await injectVideoLocator(tabId);
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

async function stopCapture(tabId, { byUser = false } = {}) {
  if (!sessions.has(tabId)) return { ok: true };
  if (byUser) {
    manualStops.add(tabId);
    await persistManualStops();
  }
  const settings = await scpLoadSettings();
  rememberEnded(tabId);
  await chrome.runtime
    .sendMessage({
      target: "offscreen",
      type: "stop-capture",
      tabId,
      // With automation on, whatever has not been saved yet is saved now.
      flushAuto: settings.autoClipEnabled
    })
    .catch(() => {});
  sessions.delete(tabId);
  await persistSessions();
  updateBadge();
  await maybeCloseOffscreen();
  return { ok: true };
}

async function requestClip(tabId, durationSeconds, { auto = false } = {}) {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: "This tab isn't being monitored." };
  const settings = await scpLoadSettings();
  // Clip length is bounded by the buffer only when the buffer is bounded.
  // Assembly is limited by what actually exists either way.
  const cap = scpBufferSeconds(settings) || Infinity;
  const dur = Math.max(5, Math.min(cap, Math.round(durationSeconds || settings.defaultClipSeconds)));
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "make-clip",
    tabId,
    durationSeconds: dur,
    postRollSeconds: settings.postRollSeconds,
    auto
  }).catch(e => ({ ok: false, error: e.message }));
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || "Clip failed." };
  }
  return res; // delivery is kicked off by the clip-ready message
}

async function clipAll(durationSeconds) {
  const ids = [...sessions.keys()];
  const results = await Promise.all(ids.map(id => requestClip(id, durationSeconds)));
  return { ok: true, count: results.filter(r => r.ok).length, total: ids.length };
}

// ---------------------------------------------------------------- automation

function autoClipIntervalMs(settings) {
  return scpAutoClipSeconds(settings) * 1000;
}

async function runAutoClips() {
  const settings = await scpLoadSettings();
  if (!settings.autoClipEnabled || sessions.size === 0) return;
  const interval = autoClipIntervalMs(settings);
  const now = Date.now();
  let changed = false;
  for (const session of sessions.values()) {
    if (session.status !== "recording") continue;
    const last = session.lastAutoClipAt || session.startedAt;
    // Alarms tick once a minute; a few seconds of slack keeps the cadence
    // from slipping a whole minute each round.
    if (now - last < interval - 5000) continue;
    session.lastAutoClipAt = now;
    changed = true;
    requestClip(session.tabId, 0, { auto: true }).catch(() => {});
  }
  if (changed) await persistSessions();
}

chrome.alarms.get(AUTO_CLIP_ALARM).then(existing => {
  if (!existing) chrome.alarms.create(AUTO_CLIP_ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== AUTO_CLIP_ALARM) return;
  await hydrate();
  await runAutoClips();
});

// ------------------------------------------------------------------ delivery

// History writes are serialized: a Drive progress update and a finished
// download can land together, and read-modify-write would drop one of them.
let historyQueue = Promise.resolve();

function mutateHistory(mutate) {
  historyQueue = historyQueue
    .then(async () => {
      const { clipHistory = [] } = await chrome.storage.local.get("clipHistory");
      mutate(clipHistory);
      if (clipHistory.length > HISTORY_LIMIT) clipHistory.length = HISTORY_LIMIT;
      await chrome.storage.local.set({ clipHistory });
    })
    .catch(() => {});
  return historyQueue;
}

function patchClip(clipId, patch) {
  return mutateHistory(list => {
    const entry = list.find(c => c.clipId === clipId);
    if (entry) Object.assign(entry, patch);
  });
}

async function findClip(clipId) {
  await historyQueue;
  const { clipHistory = [] } = await chrome.storage.local.get("clipHistory");
  return clipHistory.find(c => c.clipId === clipId) || null;
}

function releaseClipUrl(url) {
  return chrome.runtime.sendMessage({ target: "offscreen", type: "release-url", url }).catch(() => {});
}

async function persistPendingDownloads() {
  await chrome.storage.session.set({ pendingDownloads: Object.fromEntries(pendingDownloads) });
}

async function startLocalDownload(clipId, url, filename, saveAs) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: !!saveAs,
      conflictAction: "uniquify"
    });
    pendingDownloads.set(downloadId, { url, clipId });
    await persistPendingDownloads();
    await patchClip(clipId, { downloadId, local: "saving" });
    return downloadId;
  } catch (e) {
    await patchClip(clipId, { local: "failed", localError: e.message || String(e) });
    await releaseClipUrl(url);
    return null;
  }
}

// A finished clip is delivered to each enabled destination. The offscreen
// document keeps the blob alive until every one of them has finished.
async function handleClipReady(msg) {
  // msg: { tabId, url (blob), lengthSeconds, sizeBytes, extension, auto }
  const session = sessions.get(msg.tabId) || endedSessions.get(msg.tabId) || {};
  const settings = await scpLoadSettings();
  const isHighlight = msg.kind === "highlight";
  let filename = scpBuildFileName(settings.fileNameTemplate, {
    site: session.site,
    streamer: session.streamer,
    title: session.title,
    lengthSeconds: msg.lengthSeconds,
    extension: msg.extension,
    timestamp: Date.now()
  });
  if (isHighlight) {
    // Highlights get their own folder, and their score in the name, so the
    // best moments of a session are one sorted listing away.
    const parts = filename.split("/");
    const base = parts.pop();
    const dot = base.lastIndexOf(".");
    // Plain text only: Chrome's downloads API rejects names with symbols such as ★.
    const score = msg.highlight && msg.highlight.score ? ` (highlight ${msg.highlight.score})` : " (highlight)";
    filename = [...parts, "Highlights", `${base.slice(0, dot)}${score}${base.slice(dot)}`].join("/");
  }

  const drive = await scpDriveStatus();
  const wantDrive = settings.driveEnabled && drive.connected && drive.hasClientId;
  // Never let a clip go nowhere: without a usable Drive, save it locally.
  const wantLocal = settings.saveLocally || !wantDrive;
  const clipId = crypto.randomUUID();

  // The shorts engine is an extra, never the only destination: a clip is
  // always also saved locally or to Drive above.
  const engineEligible = settings.shortsEngine !== "off" &&
    (settings.shortsEngineScope === "all" || isHighlight);
  const wantEngine = engineEligible && settings.shortsRightsConfirmed;

  await chrome.runtime
    .sendMessage({
      target: "offscreen",
      type: "hold-url",
      url: msg.url,
      holds: (wantLocal ? 1 : 0) + (wantDrive ? 1 : 0) + (wantEngine ? 1 : 0)
    })
    .catch(() => {});

  await mutateHistory(list => {
    list.unshift({
      clipId,
      filename,
      site: session.site || "Stream",
      streamer: session.streamer || "stream",
      lengthSeconds: msg.lengthSeconds,
      sizeBytes: msg.sizeBytes,
      adSecondsRemoved: msg.adSecondsRemoved || 0,
      auto: !!msg.auto,
      kind: isHighlight ? "highlight" : msg.auto ? "auto" : "manual",
      highlightScore: isHighlight && msg.highlight ? msg.highlight.score : null,
      engine: wantEngine ? "sending" : engineEligible ? "failed" : "off",
      engineName: settings.shortsEngine,
      engineError: engineEligible && !wantEngine ? "Confirm you have the rights to the content in the dashboard first." : "",
      time: Date.now(),
      local: wantLocal ? "saving" : "off",
      drive: wantDrive ? "uploading" : settings.driveEnabled ? "failed" : "off",
      driveProgress: 0,
      driveError: settings.driveEnabled && !wantDrive ? "Google Drive is not connected." : ""
    });
  });

  let downloadId = null;
  if (wantLocal) {
    downloadId = await startLocalDownload(clipId, msg.url, filename, settings.askWhereToSave && !msg.auto);
  }
  if (wantDrive) {
    const folderPath = [settings.driveFolderName];
    if (settings.driveFolderPerStreamer) {
      folderPath.push(scpSanitizeFileComponent(session.streamer || "stream"));
    }
    await chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "drive-upload",
        url: msg.url,
        clipId,
        name: filename.split("/").pop(),
        folderPath
      })
      .catch(() => {});
  }

  if (wantEngine) {
    const { shortsEngineKey = "" } = await chrome.storage.local.get("shortsEngineKey");
    await chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "engine-upload",
        url: msg.url,
        clipId,
        engine: settings.shortsEngine,
        base: settings.shortsEngineUrl,
        key: shortsEngineKey,
        filename: filename.split("/").pop(),
        clipLength: settings.shortsClipLength,
        title: `${session.streamer || "Stream"}${isHighlight ? " highlight" : ""}`
      })
      .catch(() => {});
  }

  // Automatic clips stay quiet unless the user asked to hear about them.
  // A highlight is worth a notification when manual clips are.
  const shouldNotify = isHighlight
    ? settings.notifyOnAutoClip || settings.notifyOnClipSaved
    : msg.auto ? settings.notifyOnAutoClip : settings.notifyOnClipSaved;
  if (shouldNotify) {
    const mb = (msg.sizeBytes / (1024 * 1024)).toFixed(1);
    notify(
      downloadId != null ? `clip-${downloadId}` : `clipd-${clipId}`,
      isHighlight ? `Highlight saved${msg.highlight ? ` ★${msg.highlight.score}` : ""}` : msg.auto ? "Auto-clip saved" : "Clip saved",
      `${session.streamer || "Stream"} — ${scpFormatDuration(msg.lengthSeconds)} (${mb} MB)` +
        (wantDrive ? " · uploading to Drive" : "") +
        (wantEngine ? ` · sending to ${SCP_SHORTS_ENGINES[settings.shortsEngine].name}` : "")
    );
  }
}

async function handleEngineDone(msg) {
  if (msg.ok) {
    await patchClip(msg.clipId, { engine: "sent", engineJobId: msg.jobId || "", engineError: "" });
  } else {
    await patchClip(msg.clipId, { engine: "failed", engineError: msg.error || "Could not send the clip." });
    const settings = await scpLoadSettings();
    if (settings.notifyOnCaptureError) {
      const name = (SCP_SHORTS_ENGINES[msg.engine] || {}).name || "Shorts engine";
      notify(`engine-${msg.clipId}`, `${name}: clip not sent`, msg.error || "Could not send the clip.");
    }
  }
  await maybeCloseOffscreen();
}

// Reachability check from the dashboard. Both engines are FastAPI apps and
// serve /docs; any HTTP answer at all means the address is right.
async function testShortsEngine() {
  const settings = await scpLoadSettings();
  if (settings.shortsEngine === "off") return { ok: false, error: "Pick an engine first." };
  const name = SCP_SHORTS_ENGINES[settings.shortsEngine].name;
  try {
    const res = await fetch(`${settings.shortsEngineUrl}/docs`, { method: "GET", cache: "no-store" });
    return res.ok
      ? { ok: true, message: `${name} is reachable at ${settings.shortsEngineUrl}.` }
      : { ok: false, error: `${settings.shortsEngineUrl} answered HTTP ${res.status} — is that the ${name} backend (API port, usually 8000)?` };
  } catch {
    return { ok: false, error: `Nothing answered at ${settings.shortsEngineUrl}. Start ${name} (docker compose up -d) and check the address.` };
  }
}

async function handleDriveDone(msg) {
  if (msg.ok) {
    await patchClip(msg.clipId, {
      drive: "uploaded",
      driveProgress: 1,
      driveFileId: msg.id || "",
      driveLink: msg.webViewLink || "",
      driveError: ""
    });
    await maybeCloseOffscreen();
    return;
  }

  const entry = await findClip(msg.clipId);
  await patchClip(msg.clipId, { drive: "failed", driveError: msg.error || "Upload failed." });
  if (msg.url) {
    if (entry && entry.local === "off") {
      // The upload was this clip's only destination. Save it locally instead
      // of losing it; the blob's remaining hold is released when that ends.
      await startLocalDownload(msg.clipId, msg.url, entry.filename, false);
    } else {
      await releaseClipUrl(msg.url);
    }
  }
  const settings = await scpLoadSettings();
  if (settings.notifyOnCaptureError) {
    notify(
      `drive-${msg.clipId}`,
      "Google Drive upload failed",
      `${msg.error || "Upload failed."}${entry && entry.local === "off" ? " The clip was saved to Downloads instead." : ""}`
    );
  }
}

// Clicking a "Clip saved" notification reveals the file; anything else opens
// the dashboard's clip library.
chrome.notifications.onClicked.addListener(id => {
  const m = /^clip-(\d+)$/.exec(id);
  if (m) chrome.downloads.show(Number(m[1]));
  else chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html#library") });
  chrome.notifications.clear(id);
});

chrome.downloads.onChanged.addListener(async delta => {
  const state = delta.state && delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;
  await hydrate();
  const info = pendingDownloads.get(delta.id);
  if (!info) return;
  pendingDownloads.delete(delta.id);
  await persistPendingDownloads();
  await patchClip(info.clipId, { local: state === "complete" ? "saved" : "failed" });
  await releaseClipUrl(info.url);
  await maybeCloseOffscreen();
});

async function handleCaptureEnded(msg) {
  // Offscreen tells us a capture died (tab closed, stream ended, error).
  const session = sessions.get(msg.tabId);
  if (!session) return;
  rememberEnded(msg.tabId);
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
      case "drive-token":
        // From the offscreen uploader. Never interactive: uploads run unattended.
        sendResponse({ ok: true, token: await scpDriveToken({ force: !!msg.force }) });
        break;
      case "drive-progress":
        await patchClip(msg.clipId, { driveProgress: msg.fraction });
        sendResponse({ ok: true });
        break;
      case "chat-signal": {
        // From the chat reader on a stream page (or YouTube's chat frame).
        // Only monitored streams are analysed; everything else is dropped.
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId != null && sessions.has(tabId)) {
          const settings = await scpLoadSettings();
          if (settings.highlightEnabled) {
            await chrome.runtime
              .sendMessage({ target: "offscreen", type: "chat-signal", tabId, samples: msg.samples, found: msg.found, site: msg.site })
              .catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "engine-done":
        await handleEngineDone(msg);
        sendResponse({ ok: true });
        break;
      case "engine-test":
        sendResponse(await testShortsEngine());
        break;
      case "drive-done":
        await handleDriveDone(msg);
        sendResponse({ ok: true });
        break;
      case "drive-connect":
        sendResponse({ ok: true, account: await scpDriveConnect() });
        break;
      case "drive-disconnect":
        await scpDriveDisconnect();
        sendResponse({ ok: true });
        break;
      case "drive-status":
        sendResponse({ ok: true, status: await scpDriveStatus() });
        break;
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
      case "switch-quality": {
        const res = await chrome.runtime
          .sendMessage({ target: "offscreen", type: "switch-quality", tabId: msg.tabId, url: msg.url })
          .catch(e => ({ ok: false, error: e.message }));
        const session = sessions.get(msg.tabId);
        if (res && res.ok && session) {
          session.quality = res.quality;
          await persistSessions();
        }
        sendResponse(res || { ok: false, error: "Could not switch quality." });
        break;
      }
      case "get-sessions": {
        const list = await Promise.all(
          [...sessions.values()].map(async s => {
            const stats = await chrome.runtime
              .sendMessage({ target: "offscreen", type: "get-stats", tabId: s.tabId })
              .catch(() => null);
            return { ...s, stats: stats && stats.ok ? stats.stats : null };
          })
        );
        const settings = await scpLoadSettings();
        const interval = autoClipIntervalMs(settings);
        for (const s of list) {
          s.autoNextAt = settings.autoClipEnabled
            ? (s.lastAutoClipAt || s.startedAt) + interval
            : null;
        }
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
      case "video-rect": {
        // From the injected locator in a stream tab. Forward the geometry to
        // the capture engine, which owns the crop.
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId != null) {
          const { type, target, ...geometry } = msg;
          await chrome.runtime
            .sendMessage({ target: "offscreen", type: "video-rect", tabId, geometry })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: `Unknown message: ${msg.type}` });
    }
  })().catch(e => {
    // An exception must still answer the caller, or its promise never settles.
    sendResponse({ ok: false, error: (e && e.message) || String(e) });
  });
  return true; // async response
});

// Buffer length and memory cap now apply to captures already running, so
// raising them takes effect immediately instead of only on the next start.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const settings = scpNormalizeSettings(changes.settings.newValue);
  await chrome.runtime
    .sendMessage({ target: "offscreen", type: "update-settings", settings })
    .catch(() => {});
});

// Keyboard shortcuts.
chrome.commands.onCommand.addListener(async command => {
  await hydrate();
  const settings = await scpLoadSettings();
  if (command === "open-dashboard") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
    return;
  }
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
  if (sessions.has(tabId)) await stopCapture(tabId);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && !changeInfo.title) return;
  await hydrate();
  const s = sessions.get(tabId);
  if (changeInfo.url) {
    const samePage = s && scpPageKey(s.url) === scpPageKey(changeInfo.url);
    if (!samePage) {
      // A different page in the same tab (e.g. clicking through to another
      // channel). Source capture does not depend on the tab, so it would keep
      // buffering the previous stream forever — stop it, saving what is left.
      if (s) await stopCapture(tabId);
      manualStops.delete(tabId);
      playlistsByTab.delete(tabId);
      autoMonitorAttempts.delete(tabId);
      await Promise.all([persistManualStops(), persistPlaylists()]);
    }
  }
  const current = sessions.get(tabId);
  if (current && changeInfo.title) {
    current.title = changeInfo.title;
    await persistSessions();
  }
});

updateBadge();

// First run: open the dashboard so the user sees what is already switched on.
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html#live") });
  }
});
