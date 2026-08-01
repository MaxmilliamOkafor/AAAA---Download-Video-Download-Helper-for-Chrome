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
  $("#clipPresets").value = s.clipPresets.join(", ");
  $("#defaultClipMin").value = Math.floor(s.defaultClipSeconds / 60);
  $("#defaultClipSec").value = s.defaultClipSeconds % 60;
  $("#customClipEnabled").checked = s.customClipEnabled;
  setSelectValue($("#postRollSeconds"), s.postRollSeconds);
  $("#autoStartOnPopupOpen").checked = s.autoStartOnPopupOpen;
  $("#captureMode").value = s.captureMode;
  setSelectValue($("#sourceHeightCap"), s.sourceHeightCap);
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
}

function readForm() {
  const min = parseInt($("#defaultClipMin").value, 10) || 0;
  const sec = parseInt($("#defaultClipSec").value, 10) || 0;
  return {
    bufferMinutes: Number($("#bufferMinutes").value),
    maxBufferMB: Number($("#maxBufferMB").value),
    clipPresets: $("#clipPresets").value
      .split(",")
      .map(v => parseInt(v.trim(), 10))
      .filter(v => Number.isFinite(v) && v > 0),
    defaultClipSeconds: Math.max(5, min * 60 + sec),
    customClipEnabled: $("#customClipEnabled").checked,
    postRollSeconds: Number($("#postRollSeconds").value),
    autoStartOnPopupOpen: $("#autoStartOnPopupOpen").checked,
    captureMode: $("#captureMode").value,
    sourceHeightCap: Number($("#sourceHeightCap").value),
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

  $("#fileNameTemplate").addEventListener("input", updatePreview);

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
