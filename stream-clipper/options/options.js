// StreamClip Pro — options page controller.

const $ = sel => document.querySelector(sel);

function setSelectValue(el, value) {
  const str = String(value);
  if (![...el.options].some(o => o.value === str)) {
    const opt = document.createElement("option");
    opt.value = str;
    opt.textContent = str;
    el.appendChild(opt);
  }
  el.value = str;
}

function fillForm(s) {
  setSelectValue($("#bufferMinutes"), s.bufferMinutes);
  setSelectValue($("#maxBufferMB"), s.maxBufferMB);
  $("#clipPresets").value = s.clipPresets.map(scpFormatDuration).join(", ");
  $("#defaultClipMin").value = Math.floor(s.defaultClipSeconds / 60);
  $("#defaultClipSec").value = s.defaultClipSeconds % 60;
  $("#customClipEnabled").checked = s.customClipEnabled;
  setSelectValue($("#postRollSeconds"), s.postRollSeconds);
  $("#autoStartOnPopupOpen").checked = s.autoStartOnPopupOpen;
  $("#captureMode").value = s.captureMode;
  setSelectValue($("#sourceHeightCap"), s.sourceHeightCap);
  $("#cropToVideo").checked = s.cropToVideo;
  $("#excludeAds").checked = s.excludeAds;
  setSelectValue($("#resolutionCap"), s.resolutionCap);
  setSelectValue($("#frameRate"), s.frameRate);
  setSelectValue($("#videoBitrateMbps"), s.videoBitrateMbps);
  setSelectValue($("#audioBitrateKbps"), s.audioBitrateKbps);
  $("#codecPreference").value = s.codecPreference;
  $("#fileNameTemplate").value = s.fileNameTemplate;
  $("#askWhereToSave").checked = s.askWhereToSave;
  $("#notifyOnClipSaved").checked = s.notifyOnClipSaved;
  $("#notifyOnCaptureError").checked = s.notifyOnCaptureError;
  updatePreview();
  updateBufferEstimate();
}

function readForm() {
  const min = parseInt($("#defaultClipMin").value, 10) || 0;
  const sec = parseInt($("#defaultClipSec").value, 10) || 0;
  return {
    bufferMinutes: Number($("#bufferMinutes").value),
    maxBufferMB: Number($("#maxBufferMB").value),
    clipPresets: scpParseDurationList($("#clipPresets").value),
    defaultClipSeconds: Math.max(5, min * 60 + sec),
    customClipEnabled: $("#customClipEnabled").checked,
    postRollSeconds: Number($("#postRollSeconds").value),
    autoStartOnPopupOpen: $("#autoStartOnPopupOpen").checked,
    captureMode: $("#captureMode").value,
    sourceHeightCap: Number($("#sourceHeightCap").value),
    cropToVideo: $("#cropToVideo").checked,
    excludeAds: $("#excludeAds").checked,
    resolutionCap: Number($("#resolutionCap").value),
    frameRate: Number($("#frameRate").value),
    videoBitrateMbps: Number($("#videoBitrateMbps").value),
    audioBitrateKbps: Number($("#audioBitrateKbps").value),
    codecPreference: $("#codecPreference").value,
    fileNameTemplate: $("#fileNameTemplate").value,
    askWhereToSave: $("#askWhereToSave").checked,
    notifyOnClipSaved: $("#notifyOnClipSaved").checked,
    notifyOnCaptureError: $("#notifyOnCaptureError").checked
  };
}

// A long buffer is held in RAM, so show what the current choices actually
// cost before the user commits to them.
function updateBufferEstimate() {
  const minutes = Number($("#bufferMinutes").value);
  const capMB = Number($("#maxBufferMB").value);
  const mbps = Number($("#videoBitrateMbps").value);
  const el = $("#buffer-estimate");

  if (minutes === 0 || capMB === 0) {
    el.textContent =
      `Unlimited: nothing is discarded, so a stream grows about ` +
      `${scpFormatBytes(scpEstimateBytes(3600, mbps))} per hour at ~${mbps} Mbps ` +
      `(source mode uses the stream's own bitrate). Buffers are stored as browser blobs, ` +
      `which Chrome can page to disk rather than holding purely in RAM — but a very long ` +
      `session still consumes real storage, so stop monitoring when you're done.`;
    return;
  }

  const wanted = scpEstimateBytes(minutes * 60, mbps);
  const capBytes = capMB * 1024 * 1024;
  const held = Math.min(wanted, capBytes);

  let text =
    `A ${scpFormatDuration(minutes * 60)} buffer at ~${mbps} Mbps holds about ` +
    `${scpFormatBytes(wanted)} in memory, per stream.`;

  if (wanted > capBytes) {
    const actualSeconds = (capBytes * 8) / (mbps * 1e6);
    text +=
      ` Your ${scpFormatBytes(capBytes)} memory cap will cut that to roughly ` +
      `${scpFormatDuration(actualSeconds)} of footage — raise the cap to get the full length.`;
  }
  if (held > 4 * 1024 ** 3) {
    text += " That is a lot of RAM; make sure your machine has room, especially with several streams monitored at once.";
  }
  el.textContent = text;
}

function updatePreview() {
  const template = $("#fileNameTemplate").value || SCP_DEFAULT_SETTINGS.fileNameTemplate;
  $("#filename-preview").textContent = scpBuildFileName(template, {
    site: "Twitch",
    streamer: "examplestreamer",
    title: "INSANE ranked grind",
    lengthSeconds: 60,
    extension: "webm"
  });
}

function flashStatus(text) {
  const el = $("#status");
  el.textContent = text;
  setTimeout(() => { el.textContent = ""; }, 2500);
}

async function init() {
  fillForm(await scpLoadSettings());

  // Buffer length, memory and clip buttons have to move together — a 2 hour
  // button is meaningless behind a 10 minute buffer, and a long buffer is
  // silently truncated by a small memory cap.
  const QUICK_SETUPS = {
    "#preset-light":    { bufferMinutes: 10,  maxBufferMB: 600,  clipPresets: [30, 60, 300, 600] },
    "#preset-long":     { bufferMinutes: 60,  maxBufferMB: 4000, clipPresets: [60, 300, 1800, 3600] },
    "#preset-marathon": { bufferMinutes: 120, maxBufferMB: 8000, clipPresets: [60, 300, 1800, 3600, 7200] },
    // 0/0 = keep everything since monitoring started, bounded only by what the
    // browser will store. The All button then always saves the full session.
    "#preset-unlimited": { bufferMinutes: 0, maxBufferMB: 0, clipPresets: [60, 300, 1800, 3600, 7200] }
  };
  for (const [sel, values] of Object.entries(QUICK_SETUPS)) {
    $(sel).addEventListener("click", () => {
      setSelectValue($("#bufferMinutes"), values.bufferMinutes);
      setSelectValue($("#maxBufferMB"), values.maxBufferMB);
      $("#clipPresets").value = values.clipPresets.map(scpFormatDuration).join(", ");
      updateBufferEstimate();
      flashStatus("Applied — press Save settings to keep it");
    });
  }

  $("#fileNameTemplate").addEventListener("input", updatePreview);
  for (const id of ["#bufferMinutes", "#maxBufferMB", "#videoBitrateMbps"]) {
    $(id).addEventListener("change", updateBufferEstimate);
  }

  $("#save").addEventListener("click", async () => {
    await scpSaveSettings(readForm());
    fillForm(await scpLoadSettings()); // show normalized values
    flashStatus("✓ Saved — applies to newly started captures");
  });

  $("#reset").addEventListener("click", async () => {
    await scpSaveSettings(SCP_DEFAULT_SETTINGS);
    fillForm(await scpLoadSettings());
    flashStatus("Defaults restored");
  });
}

init();
