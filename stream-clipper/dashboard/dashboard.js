// StreamClip Pro — dashboard: live streams, the clip library, automation and
// every setting, in one page. Settings save as you change them.

const { send, el, toast, dateTime, localStatus, driveStatus, engineStatus, statusPill } = ScpUI;
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const VIEWS = ["live", "library", "automation", "capture", "output"];

let settings = null;
let sessions = [];
let clipHistory = [];
let drive = null;
let cards = null;
let errorTimer = null;

function showError(text) {
  const node = $("#error");
  clearTimeout(errorTimer);
  node.hidden = !text;
  node.textContent = text || "";
  if (text) errorTimer = setTimeout(() => { node.hidden = true; }, 8000);
}

// ------------------------------------------------------------------ routing

function currentView() {
  const name = location.hash.replace("#", "");
  return VIEWS.includes(name) ? name : "live";
}

function route() {
  const view = currentView();
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  for (const link of $$(".nav-item")) {
    const active = link.dataset.view === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (view === "library") renderLibrary();
}

// ----------------------------------------------------------------- settings

// Every control carries data-setting (the key) and data-kind (how its value
// maps to the setting), so adding a setting needs markup only.
function readControl(input) {
  switch (input.dataset.kind) {
    case "bool": return input.checked;
    case "number": return Number(input.value);
    case "durations": return scpParseDurationList(input.value);
    case "duration": return scpParseDuration(input.value);
    // Stored in minutes; typed as a duration. Fractions of a minute are kept.
    case "minutes": return scpParseDuration(input.value) / 60;
    default: return input.value;
  }
}

function writeControl(input, value) {
  switch (input.dataset.kind) {
    case "bool":
      input.checked = !!value;
      break;
    case "durations":
      input.value = value.map(scpFormatDuration).join(", ");
      break;
    case "duration":
      input.value = scpFormatDuration(value);
      break;
    case "minutes":
      input.value = scpFormatDuration(value * 60);
      break;
    default: {
      const text = String(value);
      // A stored value that isn't one of the listed options still has to show.
      if (input.tagName === "SELECT" && ![...input.options].some(o => o.value === text)) {
        input.append(el("option", { value: text, text }));
      }
      input.value = text;
    }
  }
}

function fillSettings() {
  for (const input of $$("[data-setting]")) {
    // Don't overwrite a field the user is typing in.
    if (document.activeElement === input && input.type === "text") continue;
    writeControl(input, settings[input.dataset.setting]);
  }
  renderEstimates();
}

async function saveSetting(input) {
  const key = input.dataset.setting;
  const value = readControl(input);
  const field = input.closest(".field");
  const invalid =
    ((input.dataset.kind === "duration" || input.dataset.kind === "minutes") && !(Number.isFinite(value) && value > 0)) ||
    (input.dataset.kind === "durations" && value.length === 0);
  if (field) field.classList.toggle("invalid", invalid);
  if (invalid) {
    toast("Use lengths like 30s, 5m or 1h");
    return;
  }
  await scpSaveSettings({ ...settings, [key]: value });
  settings = await scpLoadSettings(); // normalized
  // Show what was actually stored (clamped, de-duplicated, sanitized).
  if (document.activeElement !== input) writeControl(input, settings[key]);
  if (key === "clipPresets") cards.reset();
  toast("Saved");
  renderEstimates();
  renderPipeline();
  renderEngine();
  if (key.startsWith("drive")) refreshDrive();
}

const QUICK_SETUPS = {
  light:     { bufferMinutes: 10,  maxBufferMB: 600,  clipPresets: [30, 60, 300, 600] },
  long:      { bufferMinutes: 60,  maxBufferMB: 4000, clipPresets: [60, 300, 1800, 3600] },
  marathon:  { bufferMinutes: 120, maxBufferMB: 8000, clipPresets: [60, 300, 1800, 3600, 7200] },
  unlimited: { bufferMinutes: 0,   maxBufferMB: 0,    clipPresets: [60, 300, 1800, 3600, 7200] }
};

async function applyQuickSetup(name) {
  await scpSaveSettings({ ...settings, ...QUICK_SETUPS[name] });
  settings = await scpLoadSettings();
  cards.reset();
  fillSettings();
  toast("Applied to running captures too");
}

function renderEstimates() {
  // Buffer: what the chosen length costs, and whether the cap truncates it.
  const mbps = settings.videoBitrateMbps;
  const seconds = scpBufferSeconds(settings);
  const capBytes = settings.maxBufferMB * 1024 * 1024;
  let text;
  if (!seconds || !capBytes) {
    text = `Unlimited: nothing is discarded, so a stream grows about ${scpFormatBytes(scpEstimateBytes(3600, mbps))} ` +
      `per hour at ~${mbps} Mbps. Stop monitoring when a session is done.`;
  } else {
    const wanted = scpEstimateBytes(seconds, mbps);
    text = `A ${scpFormatDuration(seconds)} buffer at ~${mbps} Mbps holds about ${scpFormatBytes(wanted)} per stream.`;
    if (wanted > capBytes) {
      text += ` The ${scpFormatBytes(capBytes)} memory cap cuts that to roughly ` +
        `${scpFormatDuration((capBytes * 8) / (mbps * 1e6))} — raise the cap to get the full length.`;
    }
  }
  $("#buffer-estimate").textContent = text;

  // Auto-clip: effective cadence and the size of each file it will produce.
  const wantedSegment = settings.autoClipMinutes * 60;
  const segment = scpAutoClipSeconds(settings);
  let auto = `Each segment is about ${scpFormatBytes(scpEstimateBytes(segment, mbps))} at ~${mbps} Mbps ` +
    `(source mode uses the stream's own bitrate).`;
  if (segment < wantedSegment) {
    auto += ` Your ${scpFormatDuration(seconds)} buffer is shorter than the segment length, so clips are saved every ` +
      `${scpFormatDuration(segment)} instead — raise the buffer in Capture for longer segments.`;
  }
  if (scpEstimateBytes(segment, mbps) > 5 * 1024 ** 3) {
    auto += " That exceeds the 5 GB upload limit some tools apply; shorter segments are safer.";
  }
  $("#auto-estimate").textContent = auto;

  $("#filename-preview").textContent = "Example: " + scpBuildFileName(settings.fileNameTemplate, {
    site: "Twitch",
    streamer: "examplestreamer",
    title: "Ranked grind",
    lengthSeconds: settings.autoClipMinutes * 60,
    extension: settings.outputFormat === "original" ? "ts" : "mp4"
  });
}

// --------------------------------------------------------------------- live

async function refreshLive() {
  const res = await send({ type: "get-sessions" });
  sessions = (res && res.sessions) || [];
  cards.render(sessions);
  $("#live-empty").hidden = sessions.length > 0;
  $("#clip-all").hidden = sessions.length < 2;
  $("#live-lede").textContent = sessions.length
    ? `${sessions.length} stream${sessions.length > 1 ? "s" : ""} being buffered right now.`
    : "Streams being buffered right now.";
  const count = $("#nav-live");
  count.hidden = sessions.length === 0;
  count.textContent = String(sessions.length);
  renderPipeline();
}

// ------------------------------------------------------------------ library

function tile(label, value, sub) {
  return el("div", { class: "tile" }, [
    el("div", { class: "k", text: label }),
    el("div", { class: "v", text: value }),
    el("div", { class: "s", text: sub })
  ]);
}

function renderLibrary() {
  const query = $("#library-search").value.trim().toLowerCase();
  const rows = clipHistory.filter(c => !query || String(c.streamer).toLowerCase().includes(query));

  const totalSeconds = clipHistory.reduce((a, c) => a + (c.lengthSeconds || 0), 0);
  const totalBytes = clipHistory.reduce((a, c) => a + (c.sizeBytes || 0), 0);
  const uploaded = clipHistory.filter(c => c.drive === "uploaded").length;
  const uploading = clipHistory.filter(c => c.drive === "uploading").length;
  const failed = clipHistory.filter(c => c.drive === "failed" || c.local === "failed" || c.engine === "failed").length;
  const highlightCount = clipHistory.filter(c => c.kind === "highlight").length;
  const tiles = $("#library-tiles");
  tiles.textContent = "";
  tiles.append(
    tile("Clips", String(clipHistory.length), `${highlightCount} highlight${highlightCount === 1 ? "" : "s"} · ${clipHistory.filter(c => c.auto && c.kind !== "highlight").length} segments`),
    tile("Footage", scpFormatDuration(totalSeconds), scpFormatBytes(totalBytes)),
    tile("In Google Drive", String(uploaded), uploading ? `${uploading} uploading now` : "none in progress"),
    tile("Needs attention", String(failed), failed ? "see the rows marked failed" : "all deliveries succeeded")
  );

  const body = $("#library-body");
  body.textContent = "";
  for (const clip of rows) {
    const actions = el("div", { class: "row-actions" });
    if (clip.downloadId != null && clip.local !== "off" && clip.local !== "failed") {
      actions.append(el("button", {
        class: "btn btn-ghost", type: "button", text: "Show file",
        onclick: () => chrome.downloads.show(clip.downloadId)
      }));
    }
    if (clip.driveLink) {
      actions.append(el("a", {
        class: "btn btn-ghost", href: clip.driveLink, target: "_blank", rel: "noopener", text: "Open in Drive ↗"
      }));
    }
    body.append(el("tr", {}, [
      el("td", {}, el("div", { class: "clip-cell" }, [
        el("span", { class: "site-chip", dataset: { site: clip.site }, text: clip.site }),
        el("span", { class: "who", text: clip.streamer, title: clip.filename || "" }),
        clip.kind === "highlight"
          ? el("span", { class: "tag-auto tag-hl", text: clip.highlightScore ? `★ ${clip.highlightScore}` : "★", title: "Highlight found in chat (score out of 100)" })
          : clip.auto ? el("span", { class: "tag-auto", text: "AUTO", title: "Saved by auto-clip" }) : null
      ])),
      el("td", { text: scpFormatDuration(clip.lengthSeconds) +
        (clip.adSecondsRemoved > 0 ? ` (−${scpFormatDuration(clip.adSecondsRemoved)} ads)` : "") }),
      el("td", { text: scpFormatBytes(clip.sizeBytes) }),
      el("td", { text: dateTime(clip.time) }),
      el("td", {}, statusPill(localStatus(clip), clip.localError || "")),
      el("td", {}, statusPill(driveStatus(clip), clip.driveError || "")),
      el("td", {}, statusPill(engineStatus(clip),
        clip.engineError || (clip.engineJobId ? `Job ${clip.engineJobId}` : ""))),
      el("td", {}, actions)
    ]));
  }
  $("#library-table").hidden = rows.length === 0;
  $("#library-empty").hidden = rows.length > 0;
  $("#clear-history").hidden = clipHistory.length === 0;

  const count = $("#nav-library");
  count.hidden = clipHistory.length === 0;
  count.textContent = String(clipHistory.length);
}

async function loadHistory() {
  ({ clipHistory = [] } = await chrome.storage.local.get("clipHistory"));
  renderLibrary();
  renderPipeline();
}

// --------------------------------------------------------------- automation

async function refreshDrive() {
  const res = await send({ type: "drive-status" });
  drive = (res && res.status) || null;
  if (!drive) return;

  $("#redirect-uri").value = drive.redirectUri;
  const pill = $("#drive-status");
  if (drive.connected) {
    pill.dataset.state = "ok";
    pill.textContent = "Connected";
  } else if (drive.hasClientId) {
    pill.dataset.state = "warn";
    pill.textContent = "Not connected";
  } else {
    pill.dataset.state = "";
    pill.textContent = "Needs setup";
  }
  $("#drive-account").textContent = drive.connected && drive.account
    ? [drive.account.name, drive.account.email].filter(Boolean).join(" · ")
    : "";
  $("#drive-connect").hidden = drive.connected;
  $("#drive-connect").disabled = !drive.hasClientId;
  $("#drive-connect").title = drive.hasClientId ? "" : "Paste your OAuth client ID first";
  $("#drive-disconnect").hidden = !drive.connected;
  renderPipeline();
}

function stage(title, value, pill) {
  return el("div", { class: "stage" }, [
    el("div", { class: "k", text: title }),
    el("div", { class: "v", text: value }),
    statusPill(pill)
  ]);
}

function renderPipeline() {
  if (!settings) return;
  const capturing = sessions.length;
  const driveOn = settings.driveEnabled;
  const driveReady = !!(drive && drive.connected);
  const uploading = clipHistory.filter(c => c.drive === "uploading").length;

  const stages = [
    stage("1 · Capture",
      capturing ? `${capturing} stream${capturing > 1 ? "s" : ""} buffering` : "No streams yet",
      capturing ? { label: "Live", state: "ok" } : { label: "Idle", state: "" }),
    stage("2 · Clip",
      [settings.autoClipEnabled ? `Every ${scpFormatDuration(scpAutoClipSeconds(settings))}` : null,
        settings.highlightEnabled ? "highlights from chat" : null].filter(Boolean).join(" + ") || "Manual only",
      settings.autoClipEnabled || settings.highlightEnabled ? { label: "Automatic", state: "ok" } : { label: "On demand", state: "" }),
    stage("3 · Convert",
      settings.outputFormat === "original" ? "Original container" : "MP4, no re-encode",
      settings.outputFormat === "original" ? { label: ".ts", state: "warn" } : { label: "Upload-ready", state: "ok" }),
    stage("4 · Deliver",
      [settings.saveLocally ? "This computer" : null, driveOn ? "Google Drive" : null,
        settings.shortsEngine !== "off" ? SCP_SHORTS_ENGINES[settings.shortsEngine].name : null].filter(Boolean).join(" + "),
      driveOn && !driveReady
        ? { label: "Drive not connected", state: "warn" }
        : settings.shortsEngine !== "off" && !settings.shortsRightsConfirmed
          ? { label: "Engine needs your confirmation", state: "warn" }
        : uploading
          ? { label: `${uploading} uploading`, state: "busy" }
          : { label: "Ready", state: "ok" })
  ];
  const pipeline = $("#pipeline");
  pipeline.textContent = "";
  pipeline.append(...stages);

  // Compact version in the sidebar, visible from every section.
  const mini = $("#pipeline-mini");
  mini.textContent = "";
  const line = (label, pill) => el("div", { class: "line" }, [el("span", { text: label }), statusPill(pill)]);
  mini.append(
    line("Auto-clip", settings.autoClipEnabled ? { label: "On", state: "ok" } : { label: "Off", state: "" }),
    line("Highlights", settings.highlightEnabled ? { label: "On", state: "ok" } : { label: "Off", state: "" }),
    line("Drive", !driveOn ? { label: "Off", state: "" }
      : driveReady ? { label: "On", state: "ok" } : { label: "Connect", state: "warn" }),
    line("Format", { label: settings.outputFormat === "original" ? "TS" : "MP4", state: "" })
  );
}

// ------------------------------------------------------------ shorts engine

async function renderEngine() {
  const engine = SCP_SHORTS_ENGINES[settings.shortsEngine];
  $("#engine-key-label").textContent = engine ? engine.keyLabel : "API key";
  const open = $("#engine-open");
  open.hidden = !engine;
  if (engine) {
    open.href = engine.app;
    open.textContent = `Open ${engine.name} ↗`;
  }
  const pill = $("#engine-status");
  if (!engine) {
    pill.dataset.state = "";
    pill.textContent = "Off";
  } else if (!settings.shortsRightsConfirmed) {
    pill.dataset.state = "warn";
    pill.textContent = "Waiting for your rights confirmation";
  } else {
    pill.dataset.state = "ok";
    pill.textContent = `Sending ${settings.shortsEngineScope === "all" ? "every clip" : "highlights"} to ${engine.name}`;
  }
}

// --------------------------------------------------------------------- init

async function init() {
  settings = await scpLoadSettings();
  $("#version").textContent = `v${chrome.runtime.getManifest().version}`;

  cards = ScpStreamCards({
    container: $("#sessions"),
    getSettings: () => settings,
    onError: showError,
    onChanged: refreshLive
  });

  for (const input of $$("[data-setting]")) {
    input.addEventListener("change", () => saveSetting(input));
  }
  for (const button of $$("[data-quick]")) {
    button.addEventListener("click", () => applyQuickSetup(button.dataset.quick));
  }
  $("#fileNameTemplate").addEventListener("input", ev => {
    $("#filename-preview").textContent = "Example: " + scpBuildFileName(ev.target.value || settings.fileNameTemplate, {
      site: "Twitch", streamer: "examplestreamer", title: "Ranked grind",
      lengthSeconds: 900, extension: settings.outputFormat === "original" ? "ts" : "mp4"
    });
  });

  $("#clip-all").addEventListener("click", async () => {
    const res = await send({ type: "clip-all", durationSeconds: settings.defaultClipSeconds });
    if (res && res.ok) toast(`Clipping ${res.count} stream${res.count === 1 ? "" : "s"}`);
  });
  $("#library-search").addEventListener("input", renderLibrary);
  $("#clear-history").addEventListener("click", async () => {
    if (!confirm("Clear the clip list? Files on your computer and in Drive are not deleted.")) return;
    await chrome.storage.local.set({ clipHistory: [] });
  });

  $("#copy-redirect").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#redirect-uri").value);
    toast("Redirect URI copied");
  });
  $("#drive-connect").addEventListener("click", async () => {
    const button = $("#drive-connect");
    button.disabled = true;
    button.textContent = "Waiting for Google…";
    const res = await send({ type: "drive-connect" });
    button.textContent = "Connect Google Drive";
    if (!res || !res.ok) showError((res && res.error) || "Could not connect Google Drive.");
    else toast("Google Drive connected");
    await refreshDrive();
  });
  $("#drive-disconnect").addEventListener("click", async () => {
    await send({ type: "drive-disconnect" });
    toast("Google Drive disconnected");
    await refreshDrive();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && changes.clipHistory) {
      clipHistory = changes.clipHistory.newValue || [];
      renderLibrary();
      renderPipeline();
    }
    if (area === "local" && changes.driveAccount) refreshDrive();
    // Another surface (the popup's auto-clip switch) changed a setting.
    if (area === "sync" && changes.settings) {
      settings = scpNormalizeSettings(changes.settings.newValue);
      fillSettings();
      renderPipeline();
      renderEngine();
    }
  });

  // The engine key is a secret: device-local storage only, never synced.
  const { shortsEngineKey = "" } = await chrome.storage.local.get("shortsEngineKey");
  $("#engine-key").value = shortsEngineKey;
  $("#engine-key").addEventListener("change", async ev => {
    await chrome.storage.local.set({ shortsEngineKey: ev.target.value.trim() });
    toast(ev.target.value.trim() ? "Key saved on this computer" : "Key removed");
  });
  $("#engine-test").addEventListener("click", async () => {
    const button = $("#engine-test");
    button.disabled = true;
    button.textContent = "Testing…";
    const res = await send({ type: "engine-test" });
    button.disabled = false;
    button.textContent = "Test connection";
    if (res && res.ok) toast(res.message);
    else showError((res && res.error) || "Test failed.");
  });

  window.addEventListener("hashchange", route);
  fillSettings();
  renderEngine();
  route();
  await Promise.all([loadHistory(), refreshDrive(), refreshLive()]);
  setInterval(refreshLive, 2000);
}

init();
