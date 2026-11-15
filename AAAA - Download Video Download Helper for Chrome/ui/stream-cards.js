// The live stream card, shared by the popup and the dashboard.
//
// Cards are created once per tab and updated in place. Refresh runs every two
// seconds; rebuilding the cards each time would wipe whatever is half-typed
// into the custom length fields and reset an open quality dropdown.

function ScpStreamCards({ container, getSettings, onError, onChanged }) {
  const { send, el, timeOfDay } = ScpUI;
  const cards = new Map(); // tabId -> card

  const TEMPLATE = `
    <div class="session-head">
      <span class="site-chip"></span>
      <span class="session-name"></span>
      <span class="rec-dot" title="Buffering" aria-hidden="true">●</span>
      <button class="icon-btn stop" type="button" title="Stop monitoring" aria-label="Stop monitoring">✕</button>
    </div>
    <div class="quality-row">
      <span class="mode-badge"></span>
      <span class="format-tag" hidden></span>
      <select class="quality-select" aria-label="Capture quality" hidden></select>
      <span class="quality-line"></span>
    </div>
    <div class="session-meta"><span class="buffer-info"></span></div>
    <div class="note-row">
      <span class="note auto-note" data-tone="brand" hidden></span>
      <span class="note hype-note" hidden></span>
      <span class="note ad-note" hidden></span>
    </div>
    <div class="buffer-bar" role="progressbar" aria-label="Buffer filled" aria-valuemin="0" aria-valuemax="100">
      <div class="buffer-fill"></div>
    </div>
    <div class="clip-row">
      <span class="clip-label">Save the last</span>
      <div class="clip-buttons"></div>
    </div>
    <div class="custom-row">
      <input class="custom-min" type="number" min="0" max="720" placeholder="min" aria-label="Custom clip length, minutes" />
      <span aria-hidden="true">:</span>
      <input class="custom-sec" type="number" min="0" max="59" placeholder="sec" aria-label="Custom clip length, seconds" />
      <button class="btn btn-ghost custom-clip" type="button">Clip</button>
    </div>`;

  async function clip(tabId, seconds, button, labelEl) {
    const res = await send({ type: "make-clip", tabId, durationSeconds: seconds });
    if (!res || !res.ok) {
      onError((res && res.error) || "Clip failed.");
      return;
    }
    const target = labelEl || button;
    const original = target.textContent;
    button.classList.add("flash");
    target.textContent = res.pending ? `⏳ +${res.readyInSeconds}s` : "✓ Saved";
    setTimeout(() => {
      button.classList.remove("flash");
      target.textContent = original;
    }, res.pending ? 2500 : 1600);
  }

  function presetButton(label) {
    const labelEl = el("span", { text: label });
    const est = el("span", { class: "est", hidden: true });
    const btn = el("button", { class: "btn", type: "button" }, [labelEl, est]);
    return { btn, labelEl, est };
  }

  function create(session) {
    const settings = getSettings();
    const tabId = session.tabId;
    const node = el("article", { class: "session" });
    node.innerHTML = TEMPLATE; // static markup; all dynamic text is set via textContent
    const q = sel => node.querySelector(sel);
    const card = {
      node,
      bufferedSeconds: 0,
      maxBufferSeconds: 0,
      currentUrl: "",
      variantSignature: null,
      presets: [],
      els: {
        chip: q(".site-chip"), name: q(".session-name"), modeBadge: q(".mode-badge"),
        formatTag: q(".format-tag"), qualitySelect: q(".quality-select"), quality: q(".quality-line"),
        info: q(".buffer-info"), fill: q(".buffer-fill"), bar: q(".buffer-bar"),
        autoNote: q(".auto-note"), hypeNote: q(".hype-note"), adNote: q(".ad-note"), btnBox: q(".clip-buttons"),
        customRow: q(".custom-row"), min: q(".custom-min"), sec: q(".custom-sec"), customBtn: q(".custom-clip")
      }
    };
    const { els } = card;

    // "All" saves the entire buffer. It deliberately over-asks: assembly is
    // bounded by what exists, so nothing is ever trimmed.
    card.all = presetButton("All");
    card.all.btn.classList.add("btn-all");
    card.all.btn.addEventListener("click", () => {
      const seconds = Math.max(5, (card.maxBufferSeconds || card.bufferedSeconds || 60) + 120);
      clip(tabId, seconds, card.all.btn, card.all.labelEl);
    });
    els.btnBox.append(card.all.btn);

    card.presets = settings.clipPresets.map(preset => {
      const p = presetButton(scpFormatDuration(preset));
      p.preset = preset;
      p.btn.addEventListener("click", () => clip(tabId, preset, p.btn, p.labelEl));
      els.btnBox.append(p.btn);
      return p;
    });

    const submitCustom = () => {
      const total = (parseInt(els.min.value, 10) || 0) * 60 + (parseInt(els.sec.value, 10) || 0);
      if (total < 5) {
        onError("Enter at least 5 seconds — for example 2 min 30 sec.");
        els.min.focus();
        return;
      }
      clip(tabId, total, els.customBtn);
    };
    els.customBtn.addEventListener("click", submitCustom);
    for (const input of [els.min, els.sec]) {
      input.addEventListener("keydown", ev => {
        if (ev.key === "Enter") { ev.preventDefault(); submitCustom(); }
      });
    }

    // Renditions differ in resolution, so their segments cannot be joined:
    // switching restarts this stream's buffer. Confirm before discarding.
    els.qualitySelect.addEventListener("change", async ev => {
      const url = ev.target.value;
      if (card.bufferedSeconds > 30) {
        const ok = confirm(
          `Switch quality?\n\nThe ${scpFormatDuration(card.bufferedSeconds)} already buffered will be discarded — ` +
          `footage at two different resolutions can't be joined into one clip.\n\nClip what you have first if you need it.`
        );
        if (!ok) { ev.target.value = card.currentUrl; return; }
      }
      els.qualitySelect.disabled = true;
      const res = await send({ type: "switch-quality", tabId, url });
      els.qualitySelect.disabled = false;
      if (!res || !res.ok) {
        onError((res && res.error) || "Could not switch quality.");
        ev.target.value = card.currentUrl;
      }
      onChanged();
    });

    q(".stop").addEventListener("click", async () => {
      await send({ type: "stop-capture", tabId });
      onChanged();
    });
    return card;
  }

  function renderPicker(card, session, stats) {
    const { formatTag, qualitySelect } = card.els;
    const variants = (stats && stats.variants) || [];

    if (session.mode !== "source" || variants.length === 0) {
      qualitySelect.hidden = true;
      formatTag.hidden = !stats;
      formatTag.classList.add("solo");
      if (stats) {
        formatTag.textContent = session.mode === "source" ? (stats.container || "ts").toUpperCase() : "WEBM";
        formatTag.title = session.mode === "source" ? "Original segments — no re-encoding" : "Re-encoded from the rendered tab";
      }
      return;
    }

    formatTag.hidden = false;
    formatTag.classList.remove("solo");
    formatTag.textContent = (stats.container || "ts").toUpperCase();
    formatTag.title = "Original segments — no re-encoding";
    qualitySelect.hidden = false;
    card.currentUrl = stats.currentUrl || "";

    const signature = variants.map(v => v.url).join("|");
    if (card.variantSignature !== signature) {
      card.variantSignature = signature;
      qualitySelect.textContent = "";
      variants.forEach((v, i) => {
        const bits = [v.label];
        if (v.bandwidthMbps > 0) bits.push(`${v.bandwidthMbps.toFixed(1)} Mbps`);
        if (v.codec) bits.push(v.codec);
        qualitySelect.append(el("option", { value: v.url, text: (i === 0 ? "★ " : "") + bits.join(" · ") }));
      });
    }
    // Never write the value back while the user has the dropdown open.
    if (document.activeElement !== qualitySelect && card.currentUrl) qualitySelect.value = card.currentUrl;
    const best = variants[0];
    qualitySelect.title = best && card.currentUrl === best.url
      ? "Buffering the best quality this stream offers"
      : `Not the best available — ${best ? best.label : "a higher rendition"} is offered`;
  }

  function renderQualityLine(node, stats, mode) {
    node.textContent = "";
    const parts = [];
    if (stats) {
      if (stats.width && stats.height) parts.push(`${stats.width}×${stats.height}`);
      else if (stats.quality) parts.push(stats.quality);
      if (stats.frameRate) parts.push(`${stats.frameRate} fps`);
      if (stats.codec) parts.push(stats.codec);
      if (stats.bitrateMbps > 0) parts.push(`${stats.bitrateMbps.toFixed(1)} Mbps`);
    }
    if (parts.length === 0) {
      node.append(el("span", { class: "dim", text: "measuring quality…" }));
      return;
    }
    node.append(parts.join(" · "));
    node.append(el("span", {
      class: "dim",
      text: mode === "source" ? "  (no re-encode)" : stats.cropped ? "  (player only)" : "  (full tab)"
    }));
  }

  function update(card, session) {
    const settings = getSettings();
    const { els } = card;
    const stats = session.stats;
    card.bufferedSeconds = stats ? stats.bufferedSeconds : 0;
    card.maxBufferSeconds = stats ? stats.maxBufferSeconds : scpBufferSeconds(settings);

    if (els.chip.textContent !== session.site) {
      els.chip.textContent = session.site;
      els.chip.dataset.site = session.site;
    }
    const name = session.streamer || session.title || "Stream";
    if (els.name.textContent !== name) {
      els.name.textContent = name;
      els.name.title = session.title || "";
    }

    const source = session.mode === "source";
    els.modeBadge.textContent = source ? "⬥ SOURCE" : "◈ TAB";
    els.modeBadge.dataset.mode = source ? "source" : "tab";
    els.modeBadge.title = source
      ? "Buffering the broadcaster's original segments — no re-encoding, no quality loss."
      : stats && stats.cropped
        ? "Recording the player only, re-encoded. Chat and page chrome are cropped out."
        : "Recording what the tab renders. Works everywhere, but re-encodes.";

    renderPicker(card, session, stats);
    renderQualityLine(els.quality, stats, session.mode);

    if (stats) {
      const unlimited = !stats.maxBufferSeconds;
      els.info.textContent =
        `Buffer: ${scpFormatDuration(stats.bufferedSeconds)}` +
        (unlimited ? " (unlimited)" : ` / ${scpFormatDuration(stats.maxBufferSeconds)}`) +
        ` · ${scpFormatBytes(stats.bufferedBytes)} · since ${timeOfDay(stats.startedAt)}` +
        (stats.pendingClips > 0 ? ` · ⏳ ${stats.pendingClips} finishing` : "");
      const pct = unlimited ? 100 : Math.min(100, (stats.bufferedSeconds / stats.maxBufferSeconds) * 100);
      els.fill.style.width = `${pct}%`;
      els.bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    } else {
      els.info.textContent = "Buffer warming up…";
    }

    // Automation: when the next hands-free clip of this stream will be saved.
    if (session.autoNextAt) {
      const wait = Math.max(0, Math.round((session.autoNextAt - Date.now()) / 1000));
      els.autoNote.hidden = false;
      els.autoNote.textContent = wait > 0 ? `⟳ Auto-clip in ${scpFormatDuration(wait)}` : "⟳ Auto-clip saving…";
    } else {
      els.autoNote.hidden = true;
    }

    // Highlights: is chat being read, how busy is it, what has it produced.
    const hl = stats && stats.highlights;
    if (!settings.highlightEnabled || !hl) {
      els.hypeNote.hidden = true;
    } else if (!hl.chatActive) {
      els.hypeNote.hidden = false;
      els.hypeNote.dataset.tone = "warn";
      els.hypeNote.textContent = "💬 Chat not found — highlights off";
      els.hypeNote.title = "Highlights come from live chat. Keep the chat panel open on the stream's page.";
    } else {
      els.hypeNote.hidden = false;
      els.hypeNote.dataset.tone = hl.inBurst ? "warn" : hl.highlightCount ? "brand" : "";
      const count = hl.highlightCount ? ` · ${hl.highlightCount} highlight${hl.highlightCount === 1 ? "" : "s"}` : "";
      els.hypeNote.textContent = hl.inBurst
        ? "🔥 Chat is exploding — clipping this"
        : hl.warm
          ? `🔥 ${hl.messagesPerMinute} msg/min${count}`
          : `🔥 Learning chat's pace…${count}`;
      els.hypeNote.title = "Highlights are saved automatically when chat bursts well above its normal pace.";
    }

    const adSeconds = stats ? stats.adSecondsExcluded || (stats.adSegmentsSkipped || 0) * 2 : 0;
    if (stats && stats.inAdBreak) {
      els.adNote.hidden = false;
      els.adNote.dataset.tone = "warn";
      els.adNote.textContent = "⏸ Ad break — excluded";
    } else if (adSeconds > 0) {
      els.adNote.hidden = false;
      els.adNote.dataset.tone = "";
      els.adNote.textContent = `✓ ${scpFormatDuration(adSeconds)} of ads kept out`;
    } else {
      els.adNote.hidden = true;
    }

    const bitrate = stats && stats.bitrateMbps ? stats.bitrateMbps : 0;
    const available = card.bufferedSeconds;
    const maxBuffer = card.maxBufferSeconds;

    card.all.btn.title = available > 0
      ? `Save everything buffered — ${scpFormatDuration(available)} recorded so far`
      : "Save everything buffered once recording has started";
    card.all.est.hidden = !(bitrate > 0 && available > 0);
    if (!card.all.est.hidden) {
      card.all.est.textContent = `${scpFormatDuration(available)} · ~${scpFormatBytes(scpEstimateBytes(available, bitrate))}`;
    }

    for (const { preset, btn, est } of card.presets) {
      est.hidden = !(bitrate > 0);
      if (bitrate > 0) {
        est.textContent = `~${scpFormatBytes(scpEstimateBytes(Math.min(preset, available || preset), bitrate))}`;
      }
      // A preset longer than what exists still works — it saves everything
      // available — but says so rather than silently truncating.
      if (maxBuffer && preset > maxBuffer) {
        btn.classList.add("over-buffer");
        btn.title = `Longer than the ${scpFormatDuration(maxBuffer)} buffer — saves the full buffer instead. Raise the buffer length in the dashboard to clip ${scpFormatDuration(preset)}.`;
      } else if (preset > available) {
        btn.classList.add("over-buffer");
        btn.title = `Only ${scpFormatDuration(available)} buffered so far — saves what exists. Ready in ${scpFormatDuration(preset - available)}.`;
      } else {
        btn.classList.remove("over-buffer");
        btn.title = settings.postRollSeconds > 0
          ? `Save the last ${scpFormatDuration(preset)} plus ${settings.postRollSeconds}s of post-roll`
          : `Save the last ${scpFormatDuration(preset)} of this stream`;
      }
    }
    els.customRow.hidden = !settings.customClipEnabled;
  }

  function render(sessions) {
    const seen = new Set();
    for (const session of sessions) {
      seen.add(session.tabId);
      let card = cards.get(session.tabId);
      if (!card) {
        card = create(session);
        cards.set(session.tabId, card);
        container.append(card.node);
      }
      update(card, session);
    }
    for (const [tabId, card] of [...cards]) {
      if (!seen.has(tabId)) {
        card.node.remove();
        cards.delete(tabId);
      }
    }
  }

  // Preset buttons are built from settings; rebuild every card when they change.
  function reset() {
    for (const card of cards.values()) card.node.remove();
    cards.clear();
  }

  return { render, reset };
}
