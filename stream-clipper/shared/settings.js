// Shared settings model. Loaded by the service worker (importScripts),
// the offscreen document, the popup and the options page (script tags).

const SCP_DEFAULT_SETTINGS = {
  // Rolling buffer
  bufferMinutes: 10,          // how far back you can clip, per stream
  maxBufferMB: 600,           // hard memory cap per stream (oldest footage dropped first)

  // Clipping
  // Seconds, shown as one-click buttons alongside a permanent "All" button.
  clipPresets: [60, 300, 1800, 3600, 7200],
  defaultClipSeconds: 60,          // used by the keyboard shortcut
  customClipEnabled: true,         // show the free-form min/sec field in the popup
  postRollSeconds: 0,              // keep recording N extra seconds after a clip is requested
  autoStartOnPopupOpen: true,      // opening the popup on a Twitch/Kick/YouTube stream starts monitoring

  // Capture quality
  captureMode: "auto",        // auto (source when available) | source (never re-encode) | tab
  // Source mode fetches the stream a second time alongside the player, so the
  // rendition it buffers directly determines how much extra bandwidth it uses.
  // Capping at 1080p keeps that cost predictable; 0 means "always the best
  // rendition", which on a 4K stream can double or triple your usage.
  sourceHeightCap: 1080,
  // Tab mode: record the player only, dropping chat, sidebar and page chrome.
  // This also raises effective quality — the whole bitrate covers video
  // instead of being spent on static page furniture.
  cropToVideo: true,
  // Ads are detected from playlist markers (source) or the player's own ad
  // indicator (tab), and excluded from the buffer or the assembled clip.
  excludeAds: true,
  resolutionCap: 1080,        // 720 | 1080 | 1440 | 2160 (tab mode: never exceeds what the player renders)
  frameRate: 60,              // 30 | 60
  videoBitrateMbps: 8,        // 4..40 — higher costs CPU and memory while encoding live
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
  // Up to 4h of buffer and 32 GB of memory: long buffers are legitimate for
  // clipping a whole segment of a stream, and the options page shows what
  // each choice actually costs in RAM.
  s.bufferMinutes = clampNum(s.bufferMinutes, 1, 240);
  s.maxBufferMB = clampNum(s.maxBufferMB, 100, 32000);
  s.defaultClipSeconds = clampNum(s.defaultClipSeconds, 5, s.bufferMinutes * 60);
  s.clipPresets = (Array.isArray(s.clipPresets) ? s.clipPresets : SCP_DEFAULT_SETTINGS.clipPresets)
    .map(v => clampNum(v, 5, 14400))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 6);
  if (s.clipPresets.length === 0) s.clipPresets = [...SCP_DEFAULT_SETTINGS.clipPresets];
  s.postRollSeconds = clampNum(s.postRollSeconds, 0, 60);
  s.autoStartOnPopupOpen = s.autoStartOnPopupOpen !== false;
  if (!["auto", "source", "tab"].includes(s.captureMode)) s.captureMode = "auto";
  s.cropToVideo = s.cropToVideo !== false;
  s.excludeAds = s.excludeAds !== false;
  s.sourceHeightCap = [0, 720, 1080, 1440, 2160].includes(Number(s.sourceHeightCap))
    ? Number(s.sourceHeightCap)
    : 0;
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

// Human-readable codec name from a MIME type or HLS CODECS attribute.
function scpCodecLabel(raw) {
  const s = String(raw || "").toLowerCase();
  if (/avc1|h264|h\.264/.test(s)) return "H.264";
  if (/hvc1|hev1|h265|hevc/.test(s)) return "H.265";
  if (/av01/.test(s)) return "AV1";
  if (/vp9|vp09/.test(s)) return "VP9";
  if (/vp8/.test(s)) return "VP8";
  return "";
}

// Accepts "30", "30s", "2m", "1h", "1m30s" and returns seconds.
function scpParseDuration(text) {
  const s = String(text).trim().toLowerCase();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s)); // bare number = seconds
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
  }
  return matched ? Math.round(total) : NaN;
}

function scpParseDurationList(text) {
  return String(text)
    .split(",")
    .map(scpParseDuration)
    .filter(v => Number.isFinite(v) && v > 0);
}

// Compact label for a duration: 30s, 2m, 1h 30m.
function scpFormatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

// Bytes needed to buffer `seconds` at `mbps`. Used to show the memory cost of
// long buffers before the user commits to them.
function scpEstimateBytes(seconds, mbps) {
  return (seconds * mbps * 1_000_000) / 8;
}

function scpFormatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
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
    scpCodecLabel,
    scpParseDuration,
    scpParseDurationList,
    scpFormatDuration,
    scpEstimateBytes,
    scpFormatBytes,
    scpSanitizeFileComponent,
    scpBuildFileName
  });
}
