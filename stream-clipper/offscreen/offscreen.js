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
    pendingClips: new Set(), // post-roll clips waiting on their timer
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
  // Never prune footage a pending post-roll clip still needs.
  let protectedFrom = Infinity;
  for (const p of state.pendingClips) {
    protectedFrom = Math.min(protectedFrom, p.requestedAt - p.durationSeconds * 1000);
  }
  while (
    state.chunks.length > 1 &&
    state.chunks[0].t < protectedFrom &&
    (state.chunks[0].t < cutoff || state.bytes > maxBytes)
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
  const selected = state.chunks.filter(c => c.t >= startCut && c.t <= endCut);
  if (selected.length === 0 || !state.headerChunk) return;

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
      extension: "webm"
    })
    .catch(() => {});
}

function getStats(tabId) {
  const state = captures.get(tabId);
  if (!state) throw new Error("Not capturing this tab.");
  const oldest = state.chunks.length ? state.chunks[0].t : Date.now();
  return {
    bufferedSeconds: Math.round((Date.now() - oldest) / 1000),
    maxBufferSeconds: state.settings.bufferMinutes * 60,
    bufferedBytes: state.bytes,
    pendingClips: state.pendingClips.size,
    mimeType: state.recorder.mimeType,
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
  state.stream.getTracks().forEach(t => t.stop());
  state.audioCtx.close().catch(() => {});
  captures.delete(tabId);
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
