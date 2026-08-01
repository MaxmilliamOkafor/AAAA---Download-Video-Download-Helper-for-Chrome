// Shared settings model. Loaded by the service worker (importScripts),
// the offscreen document, the popup and the options page (script tags).

const SCP_DEFAULT_SETTINGS = {
  // Rolling buffer
  bufferMinutes: 10,          // how far back you can clip, per stream
  maxBufferMB: 900,           // hard memory cap per stream (oldest footage dropped first)

  // Clipping
  clipPresets: [30, 60, 120, 300], // seconds, shown as one-click buttons
  defaultClipSeconds: 60,          // used by the keyboard shortcut
  customClipEnabled: true,         // show the free-form min/sec field in the popup
  postRollSeconds: 0,              // keep recording N extra seconds after a clip is requested
  autoStartOnPopupOpen: true,      // opening the popup on a Twitch/Kick/YouTube stream starts monitoring

  // Capture quality
  resolutionCap: 1080,        // 720 | 1080 | 1440 | 2160 (capture never exceeds what the player renders)
  frameRate: 60,              // 30 | 60
  videoBitrateMbps: 12,       // 4..40
  audioBitrateKbps: 192,      // 96..320
  codecPreference: "auto",    // auto | h264 | vp9 | vp8

  // Output
  fileNameTemplate: "StreamClips/{site}/{streamer} - {date} {time} ({length}s)",
  askWhereToSave: false,

  // Notifications — quiet by default beyond a save confirmation
  notifyOnClipSaved: true,
  notifyOnBufferTrim: false,
  notifyOnCaptureError: true
};

const SCP_RESOLUTIONS = {
  720:  { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
  2160: { width: 3840, height: 2160 }
};

function scpNormalizeSettings(raw) {
  const s = { ...SCP_DEFAULT_SETTINGS, ...(raw || {}) };
  s.bufferMinutes = clampNum(s.bufferMinutes, 1, 60);
  s.maxBufferMB = clampNum(s.maxBufferMB, 100, 4000);
  s.defaultClipSeconds = clampNum(s.defaultClipSeconds, 5, s.bufferMinutes * 60);
  s.clipPresets = (Array.isArray(s.clipPresets) ? s.clipPresets : SCP_DEFAULT_SETTINGS.clipPresets)
    .map(v => clampNum(v, 5, 3600))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 6);
  if (s.clipPresets.length === 0) s.clipPresets = [...SCP_DEFAULT_SETTINGS.clipPresets];
  s.postRollSeconds = clampNum(s.postRollSeconds, 0, 60);
  s.autoStartOnPopupOpen = s.autoStartOnPopupOpen !== false;
  s.resolutionCap = SCP_RESOLUTIONS[s.resolutionCap] ? s.resolutionCap : 1080;
  s.frameRate = s.frameRate === 30 ? 30 : 60;
  s.videoBitrateMbps = clampNum(s.videoBitrateMbps, 4, 40);
  s.audioBitrateKbps = clampNum(s.audioBitrateKbps, 96, 320);
  if (!["auto", "h264", "vp9", "vp8"].includes(s.codecPreference)) s.codecPreference = "auto";
  if (typeof s.fileNameTemplate !== "string" || !s.fileNameTemplate.trim()) {
    s.fileNameTemplate = SCP_DEFAULT_SETTINGS.fileNameTemplate;
  }
  return s;

  function clampNum(v, lo, hi) {
    v = Number(v);
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  }
}

async function scpLoadSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return scpNormalizeSettings(stored.settings);
}

async function scpSaveSettings(settings) {
  await chrome.storage.sync.set({ settings: scpNormalizeSettings(settings) });
}

// Recognized streaming sites — anything else still works, labeled by hostname.
function scpSiteFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.endsWith("twitch.tv")) return "Twitch";
    if (host.endsWith("kick.com")) return "Kick";
    if (host.endsWith("youtube.com") || host === "youtu.be") return "YouTube";
    return host;
  } catch {
    return "Stream";
  }
}

// Best-effort channel/streamer name from tab URL + title.
function scpStreamerFromTab(url, title) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean);
    if ((host.endsWith("twitch.tv") || host.endsWith("kick.com")) && seg.length >= 1) {
      const reserved = ["videos", "video", "directory", "categories", "category", "search", "settings", "browse"];
      if (!reserved.includes(seg[0].toLowerCase())) return seg[0];
    }
    if (host.endsWith("youtube.com")) {
      const at = seg.find(p => p.startsWith("@"));
      if (at) return at;
      // "Title - Channel - YouTube" or "Title - YouTube"
      const m = (title || "").replace(/ - YouTube$/, "").split(" - ");
      if (m.length >= 2) return m[m.length - 1];
    }
  } catch { /* fall through */ }
  const cleaned = (title || "").replace(/ - (Twitch|Kick|YouTube)$/i, "").trim();
  return cleaned || "stream";
}

// True for URLs that look like a watchable stream page (used for auto-start).
function scpIsLikelyStreamPage(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean);
    if (host.endsWith("twitch.tv") || host.endsWith("kick.com")) {
      const reserved = ["directory", "categories", "category", "search", "settings", "browse", "wallet", "p"];
      return seg.length >= 1 && !reserved.includes(seg[0].toLowerCase());
    }
    if (host.endsWith("youtube.com")) {
      return u.pathname === "/watch" || seg[0] === "live" || seg.includes("live");
    }
    return false;
  } catch {
    return false;
  }
}

function scpSanitizeFileComponent(name) {
  return String(name)
    .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "clip";
}

function scpBuildFileName(template, meta) {
  const now = new Date(meta.timestamp || Date.now());
  const pad = n => String(n).padStart(2, "0");
  const map = {
    "{site}": scpSanitizeFileComponent(meta.site || "Stream"),
    "{streamer}": scpSanitizeFileComponent(meta.streamer || "stream"),
    "{title}": scpSanitizeFileComponent(meta.title || ""),
    "{date}": `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    "{time}": `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
    "{length}": String(Math.round(meta.lengthSeconds || 0))
  };
  let out = template;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  // Sanitize each path segment but keep folder structure.
  out = out.split("/").map(scpSanitizeFileComponent).filter(Boolean).join("/");
  return `${out}.${meta.extension || "webm"}`;
}

// Make available in both classic-script and worker contexts.
if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    SCP_DEFAULT_SETTINGS,
    SCP_RESOLUTIONS,
    scpNormalizeSettings,
    scpLoadSettings,
    scpSaveSettings,
    scpSiteFromUrl,
    scpStreamerFromTab,
    scpIsLikelyStreamPage,
    scpSanitizeFileComponent,
    scpBuildFileName
  });
}
