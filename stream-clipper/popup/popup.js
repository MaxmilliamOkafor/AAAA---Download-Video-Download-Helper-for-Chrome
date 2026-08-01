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

function renderSessions(sessions) {
  const container = $("#sessions");
  container.textContent = "";
  const tpl = $("#session-template");

  for (const s of sessions) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const chip = node.querySelector(".site-chip");
    chip.textContent = s.site;
    chip.dataset.site = s.site;
    node.querySelector(".session-name").textContent = s.streamer || s.title || "Stream";
    node.querySelector(".session-name").title = s.title || "";

    const stats = s.stats;
    const info = node.querySelector(".buffer-info");
    const modeBadge = node.querySelector(".mode-badge");
    if (s.mode === "source") {
      modeBadge.textContent = "⬥ SOURCE";
      modeBadge.title = "Buffering the broadcaster's original segments — no re-encoding, no quality loss.";
      modeBadge.dataset.mode = "source";
    } else {
      modeBadge.textContent = "◈ TAB";
      modeBadge.title = stats && stats.cropped
        ? "Recording the player only, re-encoded. Chat and page chrome are cropped out."
        : "Recording what the tab renders. Works everywhere, but re-encodes.";
      modeBadge.dataset.mode = "tab";
    }

    // Exactly what a clip will contain, before you save one.
    renderQualityLine(node.querySelector(".quality-line"), stats, s.mode);
    if (stats) {
      let text =
        `Buffer: ${fmtDuration(stats.bufferedSeconds)} / ${fmtDuration(stats.maxBufferSeconds)}` +
        ` · ${fmtBytes(stats.bufferedBytes)} · since ${new Date(stats.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      if (stats.pendingClips > 0) text += ` · ⏳ ${stats.pendingClips} clip${stats.pendingClips > 1 ? "s" : ""} finishing`;
      info.textContent = text;
      const pct = Math.min(100, (stats.bufferedSeconds / stats.maxBufferSeconds) * 100);
      node.querySelector(".buffer-fill").style.width = `${pct}%`;
      node.querySelector(".buffer-bar").setAttribute("aria-valuenow", String(Math.round(pct)));
    } else {
      info.textContent = "Buffer warming up…";
    }

    // Ads: report both a live break and the total kept out of the buffer.
    const adNote = node.querySelector(".ad-note");
    const adSeconds = stats
      ? stats.adSecondsExcluded || (stats.adSegmentsSkipped || 0) * 2
      : 0;
    if (stats && stats.inAdBreak) {
      adNote.hidden = false;
      adNote.dataset.live = "true";
      adNote.textContent = "⏸ Ad break — excluded from clips";
    } else if (adSeconds > 0) {
      adNote.hidden = false;
      adNote.dataset.live = "false";
      adNote.textContent = `✓ ${scpFormatDuration(adSeconds)} of ads kept out of this buffer`;
    } else {
      adNote.hidden = true;
    }

    const btnBox = node.querySelector(".clip-buttons");
    const bitrate = stats && stats.bitrateMbps ? stats.bitrateMbps : 0;
    const available = stats ? stats.bufferedSeconds : 0;
    const maxBuffer = stats ? stats.maxBufferSeconds : settings.bufferMinutes * 60;

    for (const preset of settings.clipPresets) {
      const b = document.createElement("button");
      b.className = "btn";

      const label = document.createElement("span");
      label.textContent = scpFormatDuration(preset);
      b.appendChild(label);

      // Estimated size for this exact preset at the measured bitrate.
      if (bitrate > 0) {
        const est = document.createElement("span");
        est.className = "est";
        est.textContent = `~${scpFormatBytes(scpEstimateBytes(Math.min(preset, available || preset), bitrate))}`;
        b.appendChild(est);
      }

      // A preset longer than the buffer can ever hold is still useful — it
      // saves everything available — but say so rather than silently truncate.
      if (preset > maxBuffer) {
        b.classList.add("over-buffer");
        b.title =
          `Longer than the ${scpFormatDuration(maxBuffer)} buffer — saves the full buffer instead. ` +
          `Raise "Buffer length" in Settings to clip ${scpFormatDuration(preset)}.`;
      } else if (preset > available) {
        b.classList.add("over-buffer");
        b.title =
          `Only ${scpFormatDuration(available)} buffered so far — saves what exists. ` +
          `Ready in ${scpFormatDuration(preset - available)}.`;
      } else {
        b.title = settings.postRollSeconds > 0
          ? `Save the last ${scpFormatDuration(preset)} plus ${settings.postRollSeconds}s of post-roll`
          : `Save the last ${scpFormatDuration(preset)} of this stream`;
      }

      b.addEventListener("click", () => doClip(s.tabId, preset, b, label));
      btnBox.appendChild(b);
    }

    const customRow = node.querySelector(".custom-row");
    if (!settings.customClipEnabled) {
      customRow.hidden = true;
    } else {
      customRow.querySelector(".custom-clip").addEventListener("click", () => {
        const min = parseInt(customRow.querySelector(".custom-min").value, 10) || 0;
        const sec = parseInt(customRow.querySelector(".custom-sec").value, 10) || 0;
        const total = min * 60 + sec;
        if (total < 5) { showError("Custom clip length must be at least 5 seconds."); return; }
        doClip(s.tabId, total, customRow.querySelector(".custom-clip"));
      });
    }

    node.querySelector(".stop").addEventListener("click", async () => {
      await send({ type: "stop-capture", tabId: s.tabId });
      refresh();
    });

    container.appendChild(node);
  }
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
