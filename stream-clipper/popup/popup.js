// StreamClip Pro — popup controller.

let settings = null;
let currentTab = null;
let refreshTimer = null;
let activeView = "streams";

const $ = sel => document.querySelector(sel);

function send(msg) {
  return chrome.runtime.sendMessage({ target: "background", ...msg });
}

function showError(text) {
  const el = $("#error");
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 6000);
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function fmtBytes(bytes) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function switchView(view) {
  activeView = view;
  const onStreams = view === "streams";
  $("#tab-streams").classList.toggle("active", onStreams);
  $("#tab-history").classList.toggle("active", !onStreams);
  $("#tab-streams").setAttribute("aria-selected", String(onStreams));
  $("#tab-history").setAttribute("aria-selected", String(!onStreams));
  $("#history-view").hidden = view !== "history";
  const streams = view === "streams";
  $("#sessions").hidden = !streams;
  if (!streams) {
    $("#current-tab").hidden = true;
    $("#empty").hidden = true;
    renderHistory();
  } else {
    refresh();
  }
}

async function refresh() {
  if (activeView !== "streams") return;
  const res = await send({ type: "get-sessions" }).catch(() => null);
  const sessions = (res && res.sessions) || [];
  renderSessions(sessions);
  renderCurrentTab(sessions);
  $("#empty").hidden = sessions.length > 0;
  $("#clip-all").hidden = sessions.length < 2;

  const count = $("#streams-count");
  count.hidden = sessions.length === 0;
  count.textContent = String(sessions.length);

  // Header subtitle doubles as an at-a-glance status line.
  const sub = $("#brand-sub");
  if (sessions.length === 0) {
    sub.textContent = "Replay buffer idle";
  } else {
    const adLive = sessions.filter(s => s.stats && s.stats.inAdBreak).length;
    sub.textContent =
      `${sessions.length} stream${sessions.length > 1 ? "s" : ""} buffering` +
      (adLive > 0 ? ` · ${adLive} in ad break` : "");
  }
}

function renderCurrentTab(sessions) {
  const box = $("#current-tab");
  if (!currentTab || !/^https?:/.test(currentTab.url || "")) { box.hidden = true; return; }
  const monitored = sessions.some(s => s.tabId === currentTab.id);
  if (monitored) { box.hidden = true; return; }
  const site = scpSiteFromUrl(currentTab.url);
  const chip = $("#current-site");
  chip.textContent = site;
  chip.dataset.site = site;
  $("#current-title").textContent = scpStreamerFromTab(currentTab.url, currentTab.title);
  box.hidden = false;
}

// Cards persist between refreshes, keyed by tab.
//
// Refresh runs every 2s. Rebuilding the cards each time wiped whatever was
// half-typed into the custom min:sec fields and stole focus mid-edit, which
// made custom lengths impossible to enter. Cards are now created once and
// updated in place; nothing that holds user input is ever replaced.
const sessionCards = new Map();

function renderSessions(sessions) {
  const container = $("#sessions");
  const seen = new Set();

  for (const s of sessions) {
    seen.add(s.tabId);
    let card = sessionCards.get(s.tabId);
    if (!card) {
      card = createSessionCard(s);
      sessionCards.set(s.tabId, card);
      container.appendChild(card.node);
    }
    updateSessionCard(card, s);
  }

  for (const [tabId, card] of [...sessionCards]) {
    if (!seen.has(tabId)) {
      card.node.remove();
      sessionCards.delete(tabId);
    }
  }
}

function createSessionCard(session) {
  const node = $("#session-template").content.firstElementChild.cloneNode(true);
  const els = {
    chip: node.querySelector(".site-chip"),
    name: node.querySelector(".session-name"),
    modeBadge: node.querySelector(".mode-badge"),
    quality: node.querySelector(".quality-line"),
    info: node.querySelector(".buffer-info"),
    fill: node.querySelector(".buffer-fill"),
    bar: node.querySelector(".buffer-bar"),
    adNote: node.querySelector(".ad-note"),
    formatTag: node.querySelector(".format-tag"),
    qualitySelect: node.querySelector(".quality-select"),
    btnBox: node.querySelector(".clip-buttons"),
    customRow: node.querySelector(".custom-row"),
    min: node.querySelector(".custom-min"),
    sec: node.querySelector(".custom-sec"),
    customBtn: node.querySelector(".custom-clip")
  };
  const tabId = session.tabId;
  const card = { node, els, presets: [], bufferedSeconds: 0, maxBufferSeconds: 0 };

  // "All" saves the entire buffer — everything recorded since monitoring
  // started, however long that is. It needs no configuration and can never be
  // over-buffer, so it always yields the maximum footage available.
  const allBtn = document.createElement("button");
  allBtn.className = "btn btn-all";
  const allLabel = document.createElement("span");
  allLabel.textContent = "All";
  const allEst = document.createElement("span");
  allEst.className = "est";
  allEst.hidden = true;
  allBtn.append(allLabel, allEst);
  allBtn.addEventListener("click", () => {
    // Ask for the full buffer window; assembly is bounded by what exists.
    const seconds = Math.max(5, card.maxBufferSeconds || card.bufferedSeconds || 60);
    doClip(tabId, seconds, allBtn, allLabel);
  });
  els.btnBox.appendChild(allBtn);
  card.all = { btn: allBtn, label: allLabel, est: allEst };

  // Built once — only the size estimates and availability change per refresh.
  const presets = settings.clipPresets.map(preset => {
    const btn = document.createElement("button");
    btn.className = "btn";
    const label = document.createElement("span");
    label.textContent = scpFormatDuration(preset);
    const est = document.createElement("span");
    est.className = "est";
    est.hidden = true;
    btn.append(label, est);
    btn.addEventListener("click", () => doClip(tabId, preset, btn, label));
    els.btnBox.appendChild(btn);
    return { preset, btn, est };
  });

  const submitCustom = () => {
    const min = parseInt(els.min.value, 10) || 0;
    const sec = parseInt(els.sec.value, 10) || 0;
    const total = min * 60 + sec;
    if (total < 5) {
      showError("Enter at least 5 seconds — for example 2 min 30 sec.");
      els.min.focus();
      return;
    }
    doClip(tabId, total, els.customBtn);
  };
  els.customBtn.addEventListener("click", submitCustom);
  // Enter submits from either field, so a custom length needs no mouse.
  for (const input of [els.min, els.sec]) {
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitCustom();
      }
    });
  }

  // Switching rendition restarts the buffer at the new quality, because
  // segments of different resolutions cannot be joined into one playable file.
  els.qualitySelect.addEventListener("change", async ev => {
    const url = ev.target.value;
    const buffered = card.bufferedSeconds;
    if (buffered > 30) {
      const ok = confirm(
        `Switch quality?\n\nThe ${scpFormatDuration(buffered)} already buffered will be discarded — ` +
        `footage at two different resolutions can't be joined into one clip.\n\n` +
        `Clip what you have first if you need it.`
      );
      if (!ok) {
        ev.target.value = card.currentUrl || "";
        return;
      }
    }
    els.qualitySelect.disabled = true;
    const res = await send({ type: "switch-quality", tabId, url })
      .catch(e => ({ ok: false, error: e.message }));
    els.qualitySelect.disabled = false;
    if (!res || !res.ok) {
      showError((res && res.error) || "Could not switch quality.");
      ev.target.value = card.currentUrl || "";
    }
    refresh();
  });

  node.querySelector(".stop").addEventListener("click", async () => {
    await send({ type: "stop-capture", tabId });
    refresh();
  });

  card.presets = presets;
  return card;
}

function updateSessionCard(card, s) {
  const { els, presets } = card;
  const stats = s.stats;
  card.bufferedSeconds = stats ? stats.bufferedSeconds : 0;
  card.maxBufferSeconds = stats ? stats.maxBufferSeconds : settings.bufferMinutes * 60;

  if (els.chip.textContent !== s.site) {
    els.chip.textContent = s.site;
    els.chip.dataset.site = s.site;
  }
  const name = s.streamer || s.title || "Stream";
  if (els.name.textContent !== name) {
    els.name.textContent = name;
    els.name.title = s.title || "";
  }

  if (s.mode === "source") {
    els.modeBadge.textContent = "⬥ SOURCE";
    els.modeBadge.title = "Buffering the broadcaster's original segments — no re-encoding, no quality loss.";
    els.modeBadge.dataset.mode = "source";
  } else {
    els.modeBadge.textContent = "◈ TAB";
    els.modeBadge.title = stats && stats.cropped
      ? "Recording the player only, re-encoded. Chat and page chrome are cropped out."
      : "Recording what the tab renders. Works everywhere, but re-encodes.";
    els.modeBadge.dataset.mode = "tab";
  }

  renderQualityPicker(card, s, stats);

  // Exactly what a clip will contain, before you save one.
  renderQualityLine(els.quality, stats, s.mode);

  if (stats) {
    let text =
      `Buffer: ${scpFormatDuration(stats.bufferedSeconds)} / ${scpFormatDuration(stats.maxBufferSeconds)}` +
      ` · ${fmtBytes(stats.bufferedBytes)} · since ${new Date(stats.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (stats.pendingClips > 0) {
      text += ` · ⏳ ${stats.pendingClips} clip${stats.pendingClips > 1 ? "s" : ""} finishing`;
    }
    els.info.textContent = text;
    const pct = Math.min(100, (stats.bufferedSeconds / stats.maxBufferSeconds) * 100);
    els.fill.style.width = `${pct}%`;
    els.bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  } else {
    els.info.textContent = "Buffer warming up…";
  }

  // Ads: report both a live break and the total kept out of the buffer.
  const adSeconds = stats ? stats.adSecondsExcluded || (stats.adSegmentsSkipped || 0) * 2 : 0;
  if (stats && stats.inAdBreak) {
    els.adNote.hidden = false;
    els.adNote.dataset.live = "true";
    els.adNote.textContent = "⏸ Ad break — excluded from clips";
  } else if (adSeconds > 0) {
    els.adNote.hidden = false;
    els.adNote.dataset.live = "false";
    els.adNote.textContent = `✓ ${scpFormatDuration(adSeconds)} of ads kept out of this buffer`;
  } else {
    els.adNote.hidden = true;
  }

  const bitrate = stats && stats.bitrateMbps ? stats.bitrateMbps : 0;
  const available = stats ? stats.bufferedSeconds : 0;
  const maxBuffer = stats ? stats.maxBufferSeconds : settings.bufferMinutes * 60;

  // "All" advertises exactly how much footage exists right now.
  if (card.all) {
    const have = available;
    card.all.btn.title = have > 0
      ? `Save everything buffered — ${scpFormatDuration(have)} recorded so far`
      : "Save everything buffered once recording has started";
    if (bitrate > 0 && have > 0) {
      card.all.est.hidden = false;
      card.all.est.textContent = `${scpFormatDuration(have)} · ~${scpFormatBytes(scpEstimateBytes(have, bitrate))}`;
    } else {
      card.all.est.hidden = true;
    }
  }

  for (const { preset, btn, est } of presets) {
    if (bitrate > 0) {
      est.hidden = false;
      est.textContent = `~${scpFormatBytes(scpEstimateBytes(Math.min(preset, available || preset), bitrate))}`;
    } else {
      est.hidden = true;
    }
    // Longer than the buffer is still useful — it saves everything available —
    // but say so rather than silently truncating.
    if (preset > maxBuffer) {
      btn.classList.add("over-buffer");
      btn.title =
        `Longer than the ${scpFormatDuration(maxBuffer)} buffer — saves the full buffer instead. ` +
        `Raise "Buffer length" in Settings to clip ${scpFormatDuration(preset)}.`;
    } else if (preset > available) {
      btn.classList.add("over-buffer");
      btn.title =
        `Only ${scpFormatDuration(available)} buffered so far — saves what exists. ` +
        `Ready in ${scpFormatDuration(preset - available)}.`;
    } else {
      btn.classList.remove("over-buffer");
      btn.title = settings.postRollSeconds > 0
        ? `Save the last ${scpFormatDuration(preset)} plus ${settings.postRollSeconds}s of post-roll`
        : `Save the last ${scpFormatDuration(preset)} of this stream`;
    }
  }

  els.customRow.hidden = !settings.customClipEnabled;
}

async function renderHistory() {
  const { clipHistory = [] } = await chrome.storage.local.get("clipHistory");
  const list = $("#history-list");
  list.textContent = "";
  $("#history-empty").hidden = clipHistory.length > 0;
  $("#history-count").textContent = clipHistory.length
    ? `${clipHistory.length} recent clip${clipHistory.length > 1 ? "s" : ""}`
    : "";
  $("#clear-history").hidden = clipHistory.length === 0;
  const badge = $("#history-badge");
  badge.hidden = clipHistory.length === 0;
  badge.textContent = String(clipHistory.length);

  const tpl = $("#history-item-template");
  for (const clip of clipHistory) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const chip = node.querySelector(".site-chip");
    chip.textContent = clip.site;
    chip.dataset.site = clip.site;
    node.querySelector(".history-name").textContent = clip.streamer;
    const meta = [
      scpFormatDuration(clip.lengthSeconds),
      fmtBytes(clip.sizeBytes),
      new Date(clip.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    ];
    if (clip.adSecondsRemoved > 0) meta.push(`${scpFormatDuration(clip.adSecondsRemoved)} of ads removed`);
    node.querySelector(".history-meta").textContent = meta.join(" · ");
    node.querySelector(".show-file").addEventListener("click", () => {
      chrome.downloads.show(clip.downloadId);
    });
    list.appendChild(node);
  }
}

// Format tag + quality dropdown listing every rendition the stream offers,
// best first, so the highest available quality is always visible and one
// click away. Options are rebuilt only when the stream's list actually
// changes, so the dropdown never resets while it is open.
function renderQualityPicker(card, s, stats) {
  const { formatTag, qualitySelect } = card.els;
  const variants = (stats && stats.variants) || [];

  if (s.mode !== "source" || variants.length === 0) {
    // Tab mode has no renditions to choose between — show what it is recording.
    formatTag.hidden = !stats || !stats.height;
    qualitySelect.hidden = true;
    if (stats && stats.height) {
      formatTag.textContent = "WEBM";
      formatTag.title = "Re-encoded from the rendered tab";
    }
    return;
  }

  formatTag.hidden = false;
  formatTag.textContent = (stats.container || "ts").toUpperCase();
  formatTag.title = stats.container === "mp4"
    ? "Original fMP4 segments — no re-encoding"
    : "Original MPEG-TS segments — no re-encoding";

  qualitySelect.hidden = false;
  card.currentUrl = stats.currentUrl || "";

  const signature = variants.map(v => v.url).join("|");
  if (card.variantSignature !== signature) {
    card.variantSignature = signature;
    qualitySelect.textContent = "";
    variants.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = v.url;
      const bits = [v.label];
      if (v.bandwidthMbps > 0) bits.push(`${v.bandwidthMbps.toFixed(1)} Mbps`);
      if (v.codec) bits.push(v.codec);
      opt.textContent = (i === 0 ? "★ " : "") + bits.join(" · ");
      opt.title = i === 0 ? "Best quality this stream offers" : "";
      qualitySelect.appendChild(opt);
    });
  }
  // Don't fight the user while the dropdown is focused/open.
  if (document.activeElement !== qualitySelect && card.currentUrl) {
    qualitySelect.value = card.currentUrl;
  }
  const best = variants[0];
  const onBest = best && card.currentUrl === best.url;
  qualitySelect.title = onBest
    ? "Buffering the best quality this stream offers"
    : `Not the best available — ${best ? best.label : "a higher rendition"} is offered`;
}

// Renders "1920×1080 · 60 fps · H.264 · 6.2 Mbps" for the active capture.
function renderQualityLine(el, stats, mode) {
  el.textContent = "";
  if (!stats) {
    el.innerHTML = '<span class="dim">measuring quality…</span>';
    return;
  }
  const parts = [];
  if (stats.width && stats.height) parts.push(`${stats.width}×${stats.height}`);
  else if (stats.quality) parts.push(stats.quality);
  if (stats.frameRate) parts.push(`${stats.frameRate} fps`);
  if (stats.codec) parts.push(stats.codec);
  if (stats.bitrateMbps > 0) parts.push(`${stats.bitrateMbps.toFixed(1)} Mbps`);

  if (parts.length === 0) {
    el.innerHTML = '<span class="dim">measuring quality…</span>';
    return;
  }
  el.appendChild(document.createTextNode(parts.join(" · ")));

  const note = document.createElement("span");
  note.className = "dim";
  note.textContent = mode === "source" ? "  (no re-encode)" : stats.cropped ? "  (player only)" : "  (full tab)";
  el.appendChild(note);
  el.title =
    mode === "source"
      ? "These are the broadcaster's original segments — clips are bit-for-bit the broadcast."
      : "Re-encoded from the rendered tab. Bitrate is measured from the live buffer.";
}

async function doClip(tabId, seconds, button, labelEl) {
  const res = await send({ type: "make-clip", tabId, durationSeconds: seconds }).catch(e => ({ ok: false, error: e.message }));
  if (!res || !res.ok) {
    showError((res && res.error) || "Clip failed.");
    return;
  }
  if (button) {
    const target = labelEl || button;
    const original = target.textContent;
    button.classList.add("flash");
    target.textContent = res.pending ? `⏳ +${res.readyInSeconds}s` : "✓ Saved";
    setTimeout(() => {
      button.classList.remove("flash");
      target.textContent = original;
    }, res.pending ? 2500 : 1600);
  }
}

async function startMonitoring(auto) {
  const btn = $("#start-current");
  btn.disabled = true;
  btn.textContent = "Starting…";
  const res = await send({ type: "start-capture", tabId: currentTab.id, auto })
    .catch(e => ({ ok: false, error: e.message }));
  btn.disabled = false;
  btn.textContent = "● Start monitoring";
  if (!res || (!res.ok && !res.suppressed)) {
    if (!auto) showError((res && res.error) || "Could not start capture.");
  }
  refresh();
}

async function init() {
  settings = await scpLoadSettings();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $("#start-current").addEventListener("click", () => startMonitoring(false));
  $("#clip-all").addEventListener("click", () => send({ type: "clip-all", durationSeconds: settings.defaultClipSeconds }));
  $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#tab-streams").addEventListener("click", () => switchView("streams"));
  $("#tab-history").addEventListener("click", () => switchView("history"));
  $("#clear-history").addEventListener("click", async () => {
    await chrome.storage.local.set({ clipHistory: [] });
    renderHistory();
  });

  await refresh();
  refreshTimer = setInterval(refresh, 2000);

  // One-click-less workflow: opening the popup on a live stream page starts
  // the buffer automatically (opt-out in settings; suppressed after a manual stop).
  if (
    settings.autoStartOnPopupOpen &&
    currentTab &&
    scpIsLikelyStreamPage(currentTab.url || "")
  ) {
    const res = await send({ type: "get-sessions" }).catch(() => null);
    const monitored = res && res.sessions && res.sessions.some(s => s.tabId === currentTab.id);
    if (!monitored) await startMonitoring(true);
  }
}

window.addEventListener("unload", () => clearInterval(refreshTimer));
init();
