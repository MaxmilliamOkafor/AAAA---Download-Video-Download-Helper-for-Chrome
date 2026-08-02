// StreamClip Pro — offscreen capture document.
// Holds one MediaRecorder per monitored tab, keeps a rolling buffer of
// timesliced chunks, and assembles "last N seconds" clips on demand.
// Clips get their WebM timecodes rebased to t=0 (webm-rebase.js) so they
// play and scrub correctly in players and editors.

const CHUNK_MS = 1000; // recorder timeslice — 1s granularity for clip boundaries

// tabId -> capture state
const captures = new Map();
// tabId -> ScpHlsBuffer, for source-quality (no re-encode) sessions
const sourceBuffers = new Map();
// blob object URLs we handed to the background for downloading
const liveUrls = new Set();

async function startSourceCapture({ tabId, playlistUrl, settings }) {
  if (sourceBuffers.has(tabId)) throw new Error("Already capturing this tab.");
  const buffer = new ScpHlsBuffer({
    tabId,
    playlistUrl,
    settings,
    onError: message => {
      sourceBuffers.delete(tabId);
      chrome.runtime
        .sendMessage({ target: "background", type: "capture-ended", tabId, error: message })
        .catch(() => {});
    }
  });
  sourceBuffers.set(tabId, buffer);
  try {
    const info = await buffer.start();
    const v = info.variant;
    return { quality: v ? `${v.height}p${v.frameRate ? Math.round(v.frameRate) : ""}` : "source" };
  } catch (e) {
    sourceBuffers.delete(tabId);
    buffer.stop();
    throw e;
  }
}

async function makeSourceClip(tabId, durationSeconds, postRollSeconds) {
  const buffer = sourceBuffers.get(tabId);
  if (!buffer) throw new Error("Not capturing this tab.");

  const deliver = async () => {
    const clip = buffer.makeClip(durationSeconds + (postRollSeconds || 0));
    const url = URL.createObjectURL(clip.blob);
    liveUrls.add(url);
    chrome.runtime
      .sendMessage({
        target: "background",
        type: "clip-ready",
        tabId,
        url,
        sizeBytes: clip.blob.size,
        lengthSeconds: clip.lengthSeconds,
        extension: clip.extension
      })
      .catch(() => {});
  };

  if (postRollSeconds > 0) {
    setTimeout(() => { deliver().catch(() => {}); }, postRollSeconds * 1000);
    return { pending: true, readyInSeconds: postRollSeconds };
  }
  await deliver();
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
    protectedFrom = Math.min(protectedFrom, p.requestedAt - p.durationSeconds * 1000);
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
function makeClip(tabId, durationSeconds, postRollSeconds) {
  const state = captures.get(tabId);
  if (!state) throw new Error("Not capturing this tab.");
  if (!state.headerChunk || state.chunks.length === 0) {
    throw new Error("The buffer is still warming up — try again in a couple of seconds.");
  }

  const pending = {
    requestedAt: Date.now(),
    durationSeconds,
    postRollSeconds: postRollSeconds || 0,
    timer: null
  };
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

  // Flush the in-flight chunk so the clip includes up-to-the-moment footage.
  try { state.recorder.requestData(); } catch { /* recorder may be stopped */ }
  await new Promise(r => setTimeout(r, 150)); // let ondataavailable land

  const startCut = pending.requestedAt - pending.durationSeconds * 1000;
  const endCut = pending.requestedAt + pending.postRollSeconds * 1000 + CHUNK_MS;
  const inRange = state.chunks.filter(c => c.t >= startCut && c.t <= endCut);
  // Drop footage recorded while an ad was on screen, so the clip cuts
  // straight from pre-ad content to where the stream resumed.
  const selected = inRange.filter(c => !isDuringAd(state, c.t));
  if (selected.length === 0 || !state.headerChunk) return;
  const adChunksDropped = inRange.length - selected.length;

  const raw = new Blob([state.headerChunk, ...selected.map(c => c.blob)], {
    type: state.recorder.mimeType || "video/webm"
  });
  const blob = await scpRebaseWebmBlob(raw);
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);

  chrome.runtime
    .sendMessage({
      target: "background",
      type: "clip-ready",
      tabId: state.tabId,
      url,
      sizeBytes: blob.size,
      lengthSeconds: Math.round(selected.length * (CHUNK_MS / 1000)),
      adSecondsRemoved: Math.round(adChunksDropped * (CHUNK_MS / 1000)),
      extension: "webm"
    })
    .catch(() => {});
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

async function stopCapture(tabId) {
  const state = captures.get(tabId);
  if (!state) return;
  state.stopping = true;
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
  await stopCapture(tabId);
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
          const buffer = sourceBuffers.get(msg.tabId);
          if (buffer) {
            buffer.stop();
            sourceBuffers.delete(msg.tabId);
          }
          await stopCapture(msg.tabId);
          sendResponse({ ok: true });
          break;
        }
        case "make-clip": {
          const res = sourceBuffers.has(msg.tabId)
            ? await makeSourceClip(msg.tabId, msg.durationSeconds, msg.postRollSeconds)
            : makeClip(msg.tabId, msg.durationSeconds, msg.postRollSeconds);
          sendResponse({ ok: true, ...res });
          break;
        }
        case "get-stats": {
          const buffer = sourceBuffers.get(msg.tabId);
          sendResponse({ ok: true, stats: buffer ? buffer.stats() : getStats(msg.tabId) });
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
            tabIds: [...new Set([...captures.keys(), ...sourceBuffers.keys()])]
          });
          break;
        case "release-url":
          if (liveUrls.has(msg.url)) {
            URL.revokeObjectURL(msg.url);
            liveUrls.delete(msg.url);
          }
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
