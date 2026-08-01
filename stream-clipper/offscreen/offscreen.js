// StreamClip Pro — offscreen capture document.
// Holds one MediaRecorder per monitored tab, keeps a rolling buffer of
// timesliced chunks, and assembles "last N seconds" clips on demand.

const CHUNK_MS = 1000; // recorder timeslice — 1s granularity for clip boundaries

// tabId -> capture state
const captures = new Map();
// blob object URLs we handed to the background for downloading
const liveUrls = new Set();

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

  const mimeType = pickMimeType(settings.codecPreference);
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: settings.videoBitrateMbps * 1_000_000,
    audioBitsPerSecond: settings.audioBitrateKbps * 1000
  });

  const state = {
    tabId,
    stream,
    recorder,
    audioCtx,
    settings,
    headerChunk: null, // first chunk: container header + init segment
    chunks: [],        // [{ t: epoch ms, blob }]
    bytes: 0,
    startedAt: Date.now(),
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
  return { mimeType: recorder.mimeType || mimeType || "video/webm" };
}

function pruneBuffer(state) {
  const maxAgeMs = state.settings.bufferMinutes * 60 * 1000;
  const maxBytes = state.settings.maxBufferMB * 1024 * 1024;
  const cutoff = Date.now() - maxAgeMs;
  while (
    state.chunks.length > 1 &&
    (state.chunks[0].t < cutoff || state.bytes > maxBytes)
  ) {
    const dropped = state.chunks.shift();
    state.bytes -= dropped.blob.size;
  }
}

function makeClip(tabId, durationSeconds) {
  const state = captures.get(tabId);
  if (!state) throw new Error("Not capturing this tab.");
  if (!state.headerChunk || state.chunks.length === 0) {
    throw new Error("The buffer is still warming up — try again in a couple of seconds.");
  }
  // Flush the in-flight chunk so the clip includes up-to-the-moment footage.
  try { state.recorder.requestData(); } catch { /* not critical */ }

  const cutoff = Date.now() - durationSeconds * 1000;
  const selected = state.chunks.filter(c => c.t >= cutoff);
  const parts = [state.headerChunk, ...selected.map(c => c.blob)];
  const blob = new Blob(parts, { type: state.recorder.mimeType || "video/webm" });
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);

  const actualSeconds = Math.min(
    durationSeconds,
    Math.round(selected.length * (CHUNK_MS / 1000)) || durationSeconds
  );
  return {
    url,
    sizeBytes: blob.size,
    lengthSeconds: actualSeconds,
    extension: "webm"
  };
}

function getStats(tabId) {
  const state = captures.get(tabId);
  if (!state) throw new Error("Not capturing this tab.");
  const oldest = state.chunks.length ? state.chunks[0].t : Date.now();
  return {
    bufferedSeconds: Math.round((Date.now() - oldest) / 1000),
    maxBufferSeconds: state.settings.bufferMinutes * 60,
    bufferedBytes: state.bytes,
    mimeType: state.recorder.mimeType,
    startedAt: state.startedAt
  };
}

function stopCapture(tabId) {
  const state = captures.get(tabId);
  if (!state) return;
  state.stopping = true;
  try { state.recorder.stop(); } catch { /* already stopped */ }
  state.stream.getTracks().forEach(t => t.stop());
  state.audioCtx.close().catch(() => {});
  captures.delete(tabId);
}

function endCapture(tabId, error) {
  const state = captures.get(tabId);
  if (!state || state.stopping) return;
  stopCapture(tabId);
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
        case "stop-capture":
          stopCapture(msg.tabId);
          sendResponse({ ok: true });
          break;
        case "make-clip": {
          const clip = makeClip(msg.tabId, msg.durationSeconds);
          // Hand the blob URL to the background, which owns downloads.
          chrome.runtime
            .sendMessage({ target: "background", type: "clip-ready", tabId: msg.tabId, ...clip })
            .catch(() => {});
          sendResponse({ ok: true, lengthSeconds: clip.lengthSeconds, sizeBytes: clip.sizeBytes });
          break;
        }
        case "get-stats":
          sendResponse({ ok: true, stats: getStats(msg.tabId) });
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
