// StreamClip Pro — offscreen capture document.
//
// Owns everything that has to outlive the service worker: the per-tab capture
// engines (source-quality HLS buffers and tab recorders), the clips they
// produce, and the Google Drive uploads that deliver them.

const CHUNK_MS = 1000; // recorder timeslice — 1s granularity for clip boundaries
// The tail of a stream is saved even when it is short: completeness matters
// more than tidiness. Only an empty or sub-segment remainder is skipped.
const MIN_AUTO_CLIP_SECONDS = 2;

// tabId -> capture state (tab mode)
const captures = new Map();
// tabId -> ScpHlsBuffer (source mode)
const sourceBuffers = new Map();

// url -> { blob, holds }. A clip stays alive until every delivery that needs
// it (local download, Drive upload) has finished; then its URL is revoked.
const clips = new Map();
let activeUploads = 0;
let assembling = 0;

function publishClip(tabId, blob, meta) {
  const url = URL.createObjectURL(blob);
  clips.set(url, { blob, holds: 0 });
  chrome.runtime
    .sendMessage({ target: "background", type: "clip-ready", tabId, url, sizeBytes: blob.size, ...meta })
    .catch(() => {});
}

function releaseClip(url) {
  const clip = clips.get(url);
  if (!clip) return;
  clip.holds -= 1;
  if (clip.holds <= 0) {
    URL.revokeObjectURL(url);
    clips.delete(url);
  }
}

// Uploads one clip to Drive in the background and reports the outcome. The
// service worker may be asleep for most of this; messages wake it.
async function uploadClipToDrive({ url, clipId, name, folderPath }) {
  const clip = clips.get(url);
  if (!clip) {
    chrome.runtime
      .sendMessage({ target: "background", type: "drive-done", clipId, ok: false, error: "Clip expired before upload." })
      .catch(() => {});
    return;
  }
  activeUploads += 1;
  let lastReported = 0;
  try {
    const file = await scpDriveUpload({
      blob: clip.blob,
      name,
      folderPath,
      getToken: async force => {
        const res = await chrome.runtime.sendMessage({ target: "background", type: "drive-token", force });
        if (!res || !res.ok) throw new Error((res && res.error) || "Google Drive is not connected.");
        return res.token;
      },
      onProgress: fraction => {
        if (fraction - lastReported < 0.05 && fraction < 1) return;
        lastReported = fraction;
        chrome.runtime
          .sendMessage({ target: "background", type: "drive-progress", clipId, fraction })
          .catch(() => {});
      }
    });
    releaseClip(url);
    chrome.runtime
      .sendMessage({ target: "background", type: "drive-done", clipId, ok: true, id: file.id, webViewLink: file.webViewLink })
      .catch(() => {});
  } catch (e) {
    // Keep the blob: the worker decides whether to fall back to a local save
    // (when Drive was the clip's only destination) before releasing it.
    chrome.runtime
      .sendMessage({ target: "background", type: "drive-done", clipId, ok: false, url, error: e.message || String(e) })
      .catch(() => releaseClip(url));
  } finally {
    activeUploads -= 1;
  }
}

// Tries each candidate playlist in order (the master first, then the
// rendition the player is polling) and keeps the first that works. A master
// is preferred because it exposes every quality the stream offers.
// ------------------------------------------------------------- highlights
//
// Chat activity arrives per second from the stream's page. Each stream gets
// its own detector, so a big channel and a small one are judged against
// their own normal pace. A detected burst becomes a clip of its own,
// assembled once the post-roll has been recorded.

const highlights = new Map(); // tabId -> highlight state

function settingsFor(tabId) {
  const buffer = sourceBuffers.get(tabId);
  if (buffer) return buffer.settings;
  const state = captures.get(tabId);
  return state ? state.settings : null;
}

function highlightState(tabId, settings) {
  let h = highlights.get(tabId);
  if (!h || h.sensitivity !== settings.highlightSensitivity) {
    h = {
      detector: new ScpHypeDetector({ sensitivity: settings.highlightSensitivity }),
      sensitivity: settings.highlightSensitivity,
      saved: [],            // events turned into clips, for the hourly cap
      pending: new Map(),   // id -> { timer, run } for clips waiting on post-roll
      chatFound: false,
      site: "",
      recent: [],           // last 60 samples, for the messages-per-minute readout
      lastSampleAt: 0
    };
    highlights.set(tabId, h);
  }
  return h;
}

function onChatSignal({ tabId, samples, found, site }) {
  const settings = settingsFor(tabId);
  if (!settings || !settings.highlightEnabled) return;
  const h = highlightState(tabId, settings);
  h.chatFound = !!found;
  h.site = site || h.site;
  for (const sample of samples || []) {
    h.recent.push(sample);
    if (h.recent.length > 60) h.recent.shift();
    h.lastSampleAt = Date.now();
    const event = h.detector.push(sample);
    if (event) acceptHighlight(tabId, h, event, settings);
  }
}

function acceptHighlight(tabId, h, event, settings) {
  if (!scpAllowHighlight(h.saved, event, settings.highlightMaxPerHour)) return;
  h.saved.push(event);
  if (h.saved.length > 200) h.saved.shift();
  const window = scpHighlightWindow(event, {
    preRoll: settings.highlightPreRoll,
    postRoll: settings.highlightPostRoll
  });
  const id = `${tabId}:${event.start}`;
  const run = () => {
    h.pending.delete(id);
    saveHighlight(tabId, window, event).catch(e => console.warn("StreamClip: highlight not saved:", e.message));
  };
  // Wait until the post-roll exists (plus a segment's grace for source mode).
  const wait = Math.max(0, window.until - Date.now()) + 2500;
  h.pending.set(id, { timer: setTimeout(run, wait), run });
}

async function saveHighlight(tabId, window, event) {
  const meta = { kind: "highlight", highlight: { score: event.score, clipCalls: event.clipCalls, peakRate: Math.round(event.peakRate * 10) / 10 } };
  const buffer = sourceBuffers.get(tabId);
  if (buffer) {
    const clip = await buffer.makeClip({ since: window.since, until: window.until });
    publishClip(tabId, clip.blob, { lengthSeconds: clip.lengthSeconds, extension: clip.extension, auto: true, ...meta });
    return;
  }
  if (captures.has(tabId)) {
    makeClip(tabId, { since: window.since, until: window.until, meta });
  }
}

// Capture is ending: close any burst still in progress and save every
// highlight that was waiting on its post-roll, with whatever exists now.
async function flushHighlights(tabId) {
  const h = highlights.get(tabId);
  if (!h) return;
  const settings = settingsFor(tabId);
  const open = h.detector.flush(Math.floor(Date.now() / 1000));
  if (open && settings) acceptHighlight(tabId, h, open, settings);
  for (const { timer, run } of [...h.pending.values()]) {
    clearTimeout(timer);
    try { await run(); } catch { /* best effort */ }
  }
  highlights.delete(tabId);
}

function highlightStats(tabId) {
  const h = highlights.get(tabId);
  if (!h) return { chatFound: false, chatActive: false };
  const fresh = Date.now() - h.lastSampleAt < 15000;
  const snap = h.detector.snapshot();
  return {
    chatFound: h.chatFound,
    chatActive: fresh,
    chatSite: h.site,
    messagesPerMinute: Math.round(h.recent.reduce((a, s) => a + (s.messages || 0), 0) * 60 / Math.max(1, h.recent.length)),
    warm: snap.warm,
    inBurst: snap.inBurst,
    highlightCount: h.saved.length,
    highlightsPending: h.pending.size
  };
}

// ---------------------------------------------------------- shorts engine

async function sendClipToEngine({ url, clipId, engine, base, key, filename, clipLength, title }) {
  const clip = clips.get(url);
  if (!clip) {
    chrome.runtime.sendMessage({ target: "background", type: "engine-done", clipId, ok: false, error: "Clip expired before it could be sent." }).catch(() => {});
    return;
  }
  activeUploads += 1;
  try {
    const out = await scpSendToShortsEngine({ engine, base, key, blob: clip.blob, filename, clipLength, title });
    chrome.runtime.sendMessage({ target: "background", type: "engine-done", clipId, ok: true, ...out }).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({ target: "background", type: "engine-done", clipId, ok: false, engine, error: e.message || String(e) }).catch(() => {});
  } finally {
    activeUploads -= 1;
    releaseClip(url);
  }
}

async function startSourceCapture({ tabId, playlistUrls, playlistUrl, settings }) {
  if (sourceBuffers.has(tabId)) throw new Error("Already capturing this tab.");
  const candidates = (playlistUrls && playlistUrls.length ? playlistUrls : [playlistUrl]).filter(Boolean);
  let lastError = new Error("No stream playlist to read.");

  for (const url of candidates) {
    const buffer = new ScpHlsBuffer({
      tabId,
      playlistUrl: url,
      settings,
      onError: async message => {
        // Runs before the buffer is cleared: with automation on, save whatever
        // has not been delivered yet so the end of a stream is never lost.
        await flushHighlights(tabId).catch(() => {});
        if (buffer.settings.autoClipEnabled) {
          await deliverSourceClip(tabId, buffer, { auto: true }).catch(() => {});
        }
        sourceBuffers.delete(tabId);
        chrome.runtime
          .sendMessage({ target: "background", type: "capture-ended", tabId, error: message })
          .catch(() => {});
      }
    });
    buffer.autoCursor = Date.now(); // automatic clips are saved up to here
    sourceBuffers.set(tabId, buffer);
    try {
      const info = await buffer.start();
      const v = info.variant;
      return { quality: v ? `${v.height}p${v.frameRate ? Math.round(v.frameRate) : ""}` : "source" };
    } catch (e) {
      sourceBuffers.delete(tabId);
      buffer.stop();
      lastError = e;
    }
  }
  throw lastError;
}

// Automatic clips cover [autoCursor, now) and advance the cursor, so
// consecutive clips tile the stream with no gap and no overlap.
async function deliverSourceClip(tabId, buffer, { durationSeconds = 0, auto = false } = {}) {
  let clip;
  if (auto) {
    const since = buffer.autoCursor;
    const until = Date.now();
    const waiting = buffer.segments.filter(s => s.t >= since && s.t < until);
    const seconds = waiting.reduce((a, s) => a + s.duration, 0);
    if (seconds < MIN_AUTO_CLIP_SECONDS) return false;
    clip = await buffer.makeClip({ since, until });
    buffer.autoCursor = until;
  } else {
    clip = await buffer.makeClip({ durationSeconds });
  }
  publishClip(tabId, clip.blob, {
    lengthSeconds: clip.lengthSeconds,
    extension: clip.extension,
    auto
  });
  return true;
}

async function makeSourceClip(tabId, { durationSeconds, postRollSeconds = 0, auto = false }) {
  const buffer = sourceBuffers.get(tabId);
  if (!buffer) throw new Error("Not capturing this tab.");
  if (buffer.segments.length === 0) {
    throw new Error("Source buffer is still filling — try again in a few seconds.");
  }
  if (auto) {
    const made = await deliverSourceClip(tabId, buffer, { auto: true });
    return { pending: false, skipped: !made };
  }
  if (postRollSeconds > 0) {
    setTimeout(() => {
      deliverSourceClip(tabId, buffer, { durationSeconds: durationSeconds + postRollSeconds }).catch(() => {});
    }, postRollSeconds * 1000);
    return { pending: true, readyInSeconds: postRollSeconds };
  }
  await deliverSourceClip(tabId, buffer, { durationSeconds });
  return { pending: false };
}

// tabId -> latest player geometry reported by the injected locator
const msgRects = new Map();

// Builds a cropped video track from the full-tab capture.
//
// The captured frame corresponds to the tab viewport, so the locator's
// CSS-pixel rect scales into frame pixels by the ratio between the two. The
// canvas is sized to the cropped region's real pixel size, which preserves
// every captured pixel of the player: cropping raises effective resolution
// rather than lowering it, since the whole bitrate now covers video only.
async function createCropper(stream, geometry, settings) {
  const track = stream.getVideoTracks()[0];
  const videoEl = document.createElement("video");
  videoEl.srcObject = new MediaStream([track]);
  videoEl.muted = true;
  videoEl.playsInline = true;
  await videoEl.play();

  // Wait for real frame dimensions before sizing anything.
  if (!videoEl.videoWidth) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frames from tab capture")), 5000);
      videoEl.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

  const state = { geometry, sx: 0, sy: 0, sw: 0, sh: 0 };

  function recomputeCrop() {
    const g = state.geometry;
    const frameW = videoEl.videoWidth;
    const frameH = videoEl.videoHeight;
    if (!g || !g.found || !frameW || !frameH) {
      state.sx = 0; state.sy = 0; state.sw = frameW; state.sh = frameH;
    } else {
      const scaleX = frameW / g.viewport.width;
      const scaleY = frameH / g.viewport.height;
      state.sx = Math.round(g.rect.x * scaleX);
      state.sy = Math.round(g.rect.y * scaleY);
      state.sw = Math.round(g.rect.width * scaleX);
      state.sh = Math.round(g.rect.height * scaleY);
    }
    // Clamp inside the frame; a stale rect must never read out of bounds.
    state.sx = Math.max(0, Math.min(state.sx, frameW - 2));
    state.sy = Math.max(0, Math.min(state.sy, frameH - 2));
    state.sw = Math.max(2, Math.min(state.sw, frameW - state.sx));
    state.sh = Math.max(2, Math.min(state.sh, frameH - state.sy));

    // Even dimensions keep H.264 encoders happy.
    const cap = SCP_RESOLUTIONS[settings.resolutionCap] || SCP_RESOLUTIONS[1080];
    let outW = state.sw;
    let outH = state.sh;
    if (outH > cap.height) {
      outW = Math.round((outW * cap.height) / outH);
      outH = cap.height;
    }
    outW -= outW % 2;
    outH -= outH % 2;
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }
  }

  recomputeCrop();

  // Offscreen documents are never rendered, so requestAnimationFrame does not
  // fire — drive the draw loop from a timer instead.
  const frameInterval = 1000 / settings.frameRate;
  const timer = setInterval(() => {
    if (videoEl.readyState < 2) return;
    try {
      ctx.drawImage(
        videoEl,
        state.sx, state.sy, state.sw, state.sh,
        0, 0, canvas.width, canvas.height
      );
    } catch { /* transient decode gap */ }
  }, frameInterval);

  const canvasStream = canvas.captureStream(settings.frameRate);
  for (const audio of stream.getAudioTracks()) canvasStream.addTrack(audio);

  return {
    stream: canvasStream,
    update(geometry) {
      state.geometry = geometry;
      recomputeCrop();
    },
    dimensions: () => ({ width: canvas.width, height: canvas.height }),
    stop() {
      clearInterval(timer);
      videoEl.pause();
      videoEl.srcObject = null;
      canvasStream.getVideoTracks().forEach(t => t.stop());
    }
  };
}

function pickMimeType(preference) {
  const candidates = {
    h264: ['video/webm;codecs="h264,opus"', 'video/x-matroska;codecs="avc1,opus"'],
    vp9: ['video/webm;codecs="vp9,opus"'],
    vp8: ['video/webm;codecs="vp8,opus"'],
    auto: [
      'video/webm;codecs="h264,opus"',
      'video/webm;codecs="vp9,opus"',
      'video/webm;codecs="vp8,opus"',
      "video/webm"
    ]
  };
  const list = [...(candidates[preference] || []), ...candidates.auto];
  for (const t of list) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return ""; // let the browser choose
}

async function startCapture({ tabId, streamId, settings }) {
  if (captures.has(tabId)) throw new Error("Already capturing this tab.");

  const res = SCP_RESOLUTIONS[settings.resolutionCap] || SCP_RESOLUTIONS[1080];
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: res.width,
        maxHeight: res.height,
        maxFrameRate: settings.frameRate
      }
    }
  });

  // Tab capture mutes the tab for the user — route the audio back out so
  // the stream stays audible while we record.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  // Crop to the player when we know where it is, so clips contain the video
  // alone instead of the whole page (chat, sidebar, headers).
  let recordedStream = stream;
  let cropper = null;
  if (settings.cropToVideo && msgRects.has(tabId)) {
    try {
      cropper = await createCropper(stream, msgRects.get(tabId), settings);
      recordedStream = cropper.stream;
    } catch (e) {
      console.warn("StreamClip: crop unavailable, recording full tab:", e.message);
    }
  }

  const mimeType = pickMimeType(settings.codecPreference);
  const recorder = new MediaRecorder(recordedStream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: settings.videoBitrateMbps * 1_000_000,
    audioBitsPerSecond: settings.audioBitrateKbps * 1000
  });

  const state = {
    tabId,
    stream,
    recorder,
    audioCtx,
    cropper,
    settings,
    headerChunk: null, // first chunk: container header + init segment
    chunks: [],        // [{ t: epoch ms, blob }]
    bytes: 0,
    startedAt: Date.now(),
    pendingClips: new Set(), // post-roll clips waiting on their timer
    adWindows: [],           // [{ start, end }] epoch ms spans that were ads
    adStartedAt: null,       // set while an ad is on screen
    adSecondsExcluded: 0,
    autoCursor: Date.now(), // automatic clips are saved up to here
    stopping: false
  };
  captures.set(tabId, state);

  recorder.ondataavailable = ev => {
    if (!ev.data || ev.data.size === 0) return;
    if (!state.headerChunk) {
      state.headerChunk = ev.data;
      state.bytes += ev.data.size;
      return;
    }
    state.chunks.push({ t: Date.now(), blob: ev.data });
    state.bytes += ev.data.size;
    pruneBuffer(state);
  };

  recorder.onerror = ev => {
    endCapture(tabId, (ev.error && ev.error.message) || "Recorder error");
  };

  // Stream dies when the tab closes or capture is revoked.
  stream.getVideoTracks()[0].addEventListener("ended", () => {
    endCapture(tabId, "The tab stopped producing video (closed or navigated away).");
  });

  recorder.start(CHUNK_MS);
  const dims = cropper ? cropper.dimensions() : null;
  return {
    mimeType: recorder.mimeType || mimeType || "video/webm",
    cropped: !!cropper,
    quality: dims ? `${dims.height}p` : null
  };
}

// Records when an ad starts and ends so clip assembly can drop those spans.
// Recording continues through the break; only the affected chunks are
// excluded, which keeps the recorder and its container header stable.
function trackAdState(state, isAd) {
  if (state.settings.excludeAds === false) return;
  if (isAd && state.adStartedAt == null) {
    state.adStartedAt = Date.now();
  } else if (!isAd && state.adStartedAt != null) {
    const window = { start: state.adStartedAt, end: Date.now() };
    state.adWindows.push(window);
    state.adSecondsExcluded += Math.round((window.end - window.start) / 1000);
    state.adStartedAt = null;
    // Only windows still reachable from the buffer are worth keeping.
    const horizon = Date.now() - state.settings.bufferMinutes * 60 * 1000;
    state.adWindows = state.adWindows.filter(w => w.end >= horizon);
  }
}

function isDuringAd(state, t) {
  // A break still in progress extends to now.
  if (state.adStartedAt != null && t >= state.adStartedAt) return true;
  return state.adWindows.some(w => t >= w.start && t <= w.end);
}

// 0 for either limit means unlimited — keep everything since recording began.
function pruneBuffer(state) {
  const maxSeconds = scpBufferSeconds(state.settings);
  const maxBytes = (state.settings.maxBufferMB || 0) * 1024 * 1024;
  if (!maxSeconds && !maxBytes) return;
  const cutoff = maxSeconds ? Date.now() - maxSeconds * 1000 : -Infinity;
  // Never prune footage a pending post-roll clip still needs.
  let protectedFrom = Infinity;
  for (const p of state.pendingClips) {
    protectedFrom = Math.min(
      protectedFrom,
      p.since != null ? p.since : p.requestedAt - p.durationSeconds * 1000
    );
  }
  while (
    state.chunks.length > 1 &&
    state.chunks[0].t < protectedFrom &&
    (state.chunks[0].t < cutoff || (maxBytes && state.bytes > maxBytes))
  ) {
    const dropped = state.chunks.shift();
    state.bytes -= dropped.blob.size;
  }
}

// Requests a clip. With post-roll, assembly is deferred so the aftermath of
// the moment is included; the clip-ready message fires when it's done.
function makeClip(tabId, { durationSeconds, postRollSeconds = 0, auto = false, since = null, until = null, meta = null }) {
  const state = captures.get(tabId);
  if (!state) throw new Error("Not capturing this tab.");
  if (!state.headerChunk || state.chunks.length === 0) {
    throw new Error("The buffer is still warming up — try again in a couple of seconds.");
  }

  const pending = {
    requestedAt: Date.now(),
    durationSeconds,
    postRollSeconds: auto ? 0 : postRollSeconds || 0,
    auto: auto || since != null,
    meta,
    // Automatic clips take the exact window since the previous one; a
    // highlight brings its own window.
    since: since != null ? since : auto ? state.autoCursor : null,
    until: until != null ? until : auto ? Date.now() : null,
    timer: null
  };
  if (auto && since == null) state.autoCursor = pending.until;
  state.pendingClips.add(pending);

  if (pending.postRollSeconds > 0) {
    pending.timer = setTimeout(() => {
      finishPendingClip(state, pending);
    }, pending.postRollSeconds * 1000);
    return { pending: true, readyInSeconds: pending.postRollSeconds };
  }
  finishPendingClip(state, pending);
  return { pending: false };
}

async function finishPendingClip(state, pending) {
  if (!state.pendingClips.has(pending)) return;
  state.pendingClips.delete(pending);
  if (pending.timer) clearTimeout(pending.timer);
  // Counted as busy so this document is not closed mid-assembly when the
  // capture that owned the footage has just been stopped.
  assembling += 1;
  try {
    await assemblePendingClip(state, pending);
  } finally {
    assembling -= 1;
  }
}

async function assemblePendingClip(state, pending) {

  // Flush the in-flight chunk so the clip includes up-to-the-moment footage.
  try { state.recorder.requestData(); } catch { /* recorder may be stopped */ }
  await new Promise(r => setTimeout(r, 150)); // let ondataavailable land

  let inRange;
  if (pending.since != null) {
    inRange = state.chunks.filter(c => c.t >= pending.since && c.t < pending.until);
  } else {
    const startCut = pending.requestedAt - pending.durationSeconds * 1000;
    const endCut = pending.requestedAt + pending.postRollSeconds * 1000 + CHUNK_MS;
    inRange = state.chunks.filter(c => c.t >= startCut && c.t <= endCut);
  }
  // Drop footage recorded while an ad was on screen, so the clip cuts
  // straight from pre-ad content to where the stream resumed.
  const selected = inRange.filter(c => !isDuringAd(state, c.t));
  if (!state.headerChunk) return;
  if (selected.length < (pending.auto ? MIN_AUTO_CLIP_SECONDS : 1)) return;
  const adChunksDropped = inRange.length - selected.length;

  const raw = new Blob([state.headerChunk, ...selected.map(c => c.blob)], {
    type: state.recorder.mimeType || "video/webm"
  });
  const blob = await scpRebaseWebmBlob(raw);
  publishClip(state.tabId, blob, {
    lengthSeconds: Math.round(selected.length * (CHUNK_MS / 1000)),
    adSecondsRemoved: Math.round(adChunksDropped * (CHUNK_MS / 1000)),
    extension: "webm",
    auto: pending.auto,
    ...(pending.meta || {})
  });
}

function getStats(tabId) {
  const state = captures.get(tabId);
  if (!state) throw new Error("Not capturing this tab.");
  const oldest = state.chunks.length ? state.chunks[0].t : Date.now();
  const bufferedSeconds = Math.round((Date.now() - oldest) / 1000);

  // Report the dimensions actually being recorded: the cropped canvas when
  // cropping is active, otherwise the raw capture track.
  let width = 0;
  let height = 0;
  let frameRate = state.settings.frameRate;
  if (state.cropper) {
    const d = state.cropper.dimensions();
    width = d.width;
    height = d.height;
  } else {
    const track = state.stream.getVideoTracks()[0];
    const ts = track ? track.getSettings() : {};
    width = ts.width || 0;
    height = ts.height || 0;
    if (ts.frameRate) frameRate = Math.round(ts.frameRate);
  }

  return {
    mode: "tab",
    bufferedSeconds,
    maxBufferSeconds: scpBufferSeconds(state.settings), // 0 = unlimited
    bufferedBytes: state.bytes,
    pendingClips: state.pendingClips.size,
    mimeType: state.recorder.mimeType,
    width,
    height,
    frameRate,
    codec: scpCodecLabel(state.recorder.mimeType),
    cropped: !!state.cropper,
    adSecondsExcluded: state.adSecondsExcluded,
    inAdBreak: state.adStartedAt != null,
    // Measured from real buffered data, so it reflects what will be saved
    // rather than the configured target.
    bitrateMbps: bufferedSeconds > 0 ? (state.bytes * 8) / bufferedSeconds / 1e6 : 0,
    startedAt: state.startedAt
  };
}

async function flushPendingClips(state) {
  // Capture is ending — salvage any post-roll clips with what we have now.
  const pendings = [...state.pendingClips];
  for (const p of pendings) await finishPendingClip(state, p);
}

async function stopCapture(tabId, { flushAuto = false } = {}) {
  const state = captures.get(tabId);
  if (!state) return;
  state.stopping = true;
  if (flushAuto && state.headerChunk && state.chunks.length > 0) {
    try { makeClip(tabId, { auto: true }); } catch { /* nothing to save */ }
  }
  await flushPendingClips(state);
  try { state.recorder.stop(); } catch { /* already stopped */ }
  if (state.cropper) state.cropper.stop();
  state.stream.getTracks().forEach(t => t.stop());
  state.audioCtx.close().catch(() => {});
  captures.delete(tabId);
  msgRects.delete(tabId);
}

async function endCapture(tabId, error) {
  const state = captures.get(tabId);
  if (!state || state.stopping) return;
  await flushHighlights(tabId).catch(() => {});
  await stopCapture(tabId, { flushAuto: !!state.settings.autoClipEnabled });
  chrome.runtime
    .sendMessage({ target: "background", type: "capture-ended", tabId, error })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  (async () => {
    try {
      switch (msg.type) {
        case "start-capture": {
          const info = await startCapture(msg);
          sendResponse({ ok: true, ...info });
          break;
        }
        case "start-source-capture": {
          const info = await startSourceCapture(msg);
          sendResponse({ ok: true, ...info });
          break;
        }
        case "stop-capture": {
          await flushHighlights(msg.tabId);
          const buffer = sourceBuffers.get(msg.tabId);
          if (buffer) {
            if (msg.flushAuto) {
              await deliverSourceClip(msg.tabId, buffer, { auto: true }).catch(() => {});
            }
            buffer.stop();
            sourceBuffers.delete(msg.tabId);
          }
          await stopCapture(msg.tabId, { flushAuto: !!msg.flushAuto });
          sendResponse({ ok: true });
          break;
        }
        case "make-clip": {
          const request = {
            durationSeconds: msg.durationSeconds,
            postRollSeconds: msg.postRollSeconds,
            auto: !!msg.auto
          };
          const res = sourceBuffers.has(msg.tabId)
            ? await makeSourceClip(msg.tabId, request)
            : makeClip(msg.tabId, request);
          sendResponse({ ok: true, ...res });
          break;
        }
        case "get-stats": {
          const buffer = sourceBuffers.get(msg.tabId);
          const base = buffer ? buffer.stats() : getStats(msg.tabId);
          sendResponse({ ok: true, stats: { ...base, highlights: highlightStats(msg.tabId) } });
          break;
        }
        case "video-rect": {
          // Player geometry from the injected locator; keep the crop in step
          // with theater mode, fullscreen and window resizes.
          msgRects.set(msg.tabId, msg.geometry);
          const state = captures.get(msg.tabId);
          if (state) {
            if (state.cropper && msg.geometry && msg.geometry.found) {
              state.cropper.update(msg.geometry);
            }
            trackAdState(state, !!(msg.geometry && msg.geometry.isAd));
          }
          sendResponse({ ok: true });
          break;
        }
        case "switch-quality": {
          const buffer = sourceBuffers.get(msg.tabId);
          if (!buffer) throw new Error("Quality switching needs source mode.");
          const info = await buffer.switchTo(msg.url);
          sendResponse({ ok: true, ...info });
          break;
        }
        case "peek-rect":
          sendResponse({
            ok: true,
            has: msgRects.has(msg.tabId) && !!(msgRects.get(msg.tabId) || {}).found
          });
          break;
        case "update-settings": {
          // Apply live to running captures. Buffer limits are read on every
          // prune, so a raised limit simply stops discarding; a lowered one
          // trims on the next tick.
          for (const state of captures.values()) {
            state.settings = { ...state.settings, ...msg.settings };
          }
          for (const buffer of sourceBuffers.values()) {
            buffer.settings = { ...buffer.settings, ...msg.settings };
          }
          sendResponse({ ok: true });
          break;
        }
        case "list-captures":
          // The service worker asks this after a restart to rebuild its
          // session registry — this document is the authority on what is live.
          sendResponse({
            ok: true,
            tabIds: [...new Set([...captures.keys(), ...sourceBuffers.keys()])],
            // Clips still being downloaded or uploaded keep this document alive.
            busy: clips.size + activeUploads + assembling
          });
          break;
        case "hold-url": {
          // How many deliveries will consume this clip. Zero means none will.
          const clip = clips.get(msg.url);
          if (clip) {
            clip.holds = msg.holds;
            if (clip.holds <= 0) releaseClip(msg.url);
          }
          sendResponse({ ok: true });
          break;
        }
        case "release-url":
          releaseClip(msg.url);
          sendResponse({ ok: true });
          break;
        case "chat-signal":
          onChatSignal(msg);
          sendResponse({ ok: true });
          break;
        case "engine-upload":
          sendClipToEngine(msg); // long-running; reports via engine-done
          sendResponse({ ok: true });
          break;
        case "drive-upload":
          uploadClipToDrive(msg); // long-running; reports via drive-done
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});
