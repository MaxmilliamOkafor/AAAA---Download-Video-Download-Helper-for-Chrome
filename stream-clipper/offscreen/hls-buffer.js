// Source-quality rolling buffer.
//
// Instead of re-encoding rendered pixels, this follows the stream's own HLS
// media playlist and keeps the most recent *original* segments in memory.
// A clip is those segments concatenated — the exact bytes the CDN sent, with
// no decode/encode round trip, so quality equals the broadcast.
//
// It also always buffers the highest-bandwidth rendition the stream offers
// (subject to the user's cap), so you can watch at 720p to save bandwidth
// and still clip at 1080p60 source.

class ScpHlsBuffer {
  constructor({ tabId, playlistUrl, settings, onError }) {
    this.tabId = tabId;
    this.playlistUrl = playlistUrl;
    this.settings = settings;
    this.onError = onError || (() => {});

    this.mediaUrl = null;      // resolved rendition playlist
    this.variant = null;       // chosen rendition metadata
    this.variants = [];        // every rendition the stream offers, best first
    this.initSegment = null;   // { url, bytes } for fMP4
    this.segments = [];        // [{ seq, duration, t, bytes: Uint8Array }]
    this.bytes = 0;
    this.seenSeq = new Set();
    this.startedAt = Date.now();
    this.stopped = false;
    this.pollTimer = null;
    this.consecutiveFailures = 0;
    this.container = "ts";     // ts | mp4
    this.primed = false;       // false until the live-edge starting point is set
    this.adSegmentsSkipped = 0;
    this.inAdBreak = false;
  }

  async start() {
    const text = await this.#fetchText(this.playlistUrl);
    if (scpIsMasterPlaylist(text)) {
      this.variants = scpParseMasterPlaylist(text, this.playlistUrl);
      const cap = this.settings.sourceHeightCap || 0;
      this.variant = scpPickVariant(this.variants, cap);
      if (!this.variant) throw new Error("No playable renditions in the stream playlist.");
      this.mediaUrl = this.variant.url;
    } else {
      this.mediaUrl = this.playlistUrl;
    }
    await this.#poll(); // prime immediately so the buffer starts filling
    this.#scheduleNext();
    return {
      variant: this.variant,
      mediaUrl: this.mediaUrl
    };
  }

  // Switches which rendition is buffered. Renditions differ in resolution and
  // encoder state, so segments from two of them cannot be concatenated into a
  // playable file — the buffer restarts empty at the new quality.
  async switchTo(url) {
    const next = this.variants.find(v => v.url === url);
    if (!next) throw new Error("That quality is not offered by this stream.");
    if (this.pollTimer) clearTimeout(this.pollTimer);

    this.variant = next;
    this.mediaUrl = url;
    this.segments = [];
    this.seenSeq.clear();
    this.bytes = 0;
    this.initSegment = null;
    this.primed = false;
    this.startedAt = Date.now();
    this.consecutiveFailures = 0;

    await this.#poll();
    this.#scheduleNext();
    return { quality: this.#label(next) };
  }

  #label(v) {
    if (!v) return "source";
    const fps = v.frameRate ? Math.round(v.frameRate) : 0;
    return `${v.height}p${fps && fps > 30 ? fps : ""}`;
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.segments = [];
    this.seenSeq.clear();
    this.bytes = 0;
  }

  stats() {
    const bufferedSeconds = this.segments.reduce((a, s) => a + s.duration, 0);
    const v = this.variant;
    return {
      mode: "source",
      bufferedSeconds: Math.round(bufferedSeconds),
      maxBufferSeconds: scpBufferSeconds(this.settings), // 0 = unlimited
      bufferedBytes: this.bytes,
      startedAt: this.startedAt,
      quality: v ? `${v.height}p${v.frameRate ? Math.round(v.frameRate) : ""}` : "source",
      width: v ? v.width : 0,
      height: v ? v.height : 0,
      frameRate: v && v.frameRate ? Math.round(v.frameRate) : 0,
      codec: v ? scpCodecLabel(v.codecs) : "",
      container: this.container,
      adSegmentsSkipped: this.adSegmentsSkipped,
      inAdBreak: this.inAdBreak,
      // Everything the stream offers, so the popup can present a real picker.
      currentUrl: this.mediaUrl,
      variants: this.variants.map(v => ({
        url: v.url,
        label: this.#label(v),
        height: v.height,
        frameRate: v.frameRate ? Math.round(v.frameRate) : 0,
        bandwidthMbps: v.bandwidth ? v.bandwidth / 1e6 : 0,
        codec: scpCodecLabel(v.codecs)
      })),
      // Prefer the rendition's advertised bandwidth; fall back to measured.
      bitrateMbps: v && v.bandwidth
        ? v.bandwidth / 1e6
        : bufferedSeconds > 0 ? (this.bytes * 8) / bufferedSeconds / 1e6 : 0,
      segmentCount: this.segments.length
    };
  }

  // Returns a Blob of the trailing `durationSeconds` of original segments.
  makeClip(durationSeconds) {
    if (this.segments.length === 0) {
      throw new Error("Source buffer is still filling — try again in a few seconds.");
    }
    const selected = [];
    let total = 0;
    // Walk backwards from newest until we have enough footage.
    for (let i = this.segments.length - 1; i >= 0; i--) {
      selected.unshift(this.segments[i]);
      total += this.segments[i].duration;
      if (total >= durationSeconds) break;
    }
    const parts = [];
    // fMP4 needs its init segment first or the file is undecodable.
    if (this.container === "mp4" && this.initSegment) parts.push(this.initSegment.bytes);
    for (const s of selected) parts.push(s.bytes);

    const type = this.container === "mp4" ? "video/mp4" : "video/mp2t";
    return {
      blob: new Blob(parts, { type }),
      lengthSeconds: Math.round(total),
      extension: this.container === "mp4" ? "mp4" : "ts"
    };
  }

  #scheduleNext(delayMs) {
    if (this.stopped) return;
    // Poll at about half the segment duration so we never miss a segment.
    const base = delayMs != null ? delayMs : Math.max(1000, (this.targetDuration || 2) * 500);
    this.pollTimer = setTimeout(() => this.#poll().then(() => this.#scheduleNext()), base);
  }

  async #poll() {
    if (this.stopped) return;
    try {
      const text = await this.#fetchText(this.mediaUrl);
      const playlist = scpParseMediaPlaylist(text, this.mediaUrl);
      this.targetDuration = playlist.targetDuration || this.targetDuration;

      if (playlist.initSegmentUrl) {
        this.container = "mp4";
        if (!this.initSegment || this.initSegment.url !== playlist.initSegmentUrl) {
          const bytes = await this.#fetchBytes(playlist.initSegmentUrl);
          this.initSegment = { url: playlist.initSegmentUrl, bytes };
        }
      }

      let fresh = playlist.segments.filter(s => !this.seenSeq.has(s.seq));

      // On the very first poll the playlist already holds a full sliding
      // window (~10 segments on Twitch). Downloading it all at once bursts
      // tens of megabytes against the player and visibly stutters the stream.
      // Start at the live edge instead: mark the backlog seen and buffer
      // forward from now. Nothing is lost — monitoring only ever captures
      // footage from the moment it starts.
      if (!this.primed) {
        this.primed = true;
        const edge = fresh.slice(-1);
        for (const seg of fresh.slice(0, -1)) this.seenSeq.add(seg.seq);
        fresh = edge;
      }

      this.inAdBreak = !!playlist.inAdBreak;

      for (const seg of fresh) {
        if (this.stopped) return;
        // Advertising never enters the buffer, so it can never reach a clip.
        // Skipping the download also saves the bandwidth it would have cost.
        if (seg.isAd && this.settings.excludeAds !== false) {
          this.seenSeq.add(seg.seq);
          this.adSegmentsSkipped++;
          continue;
        }
        try {
          const bytes = await this.#fetchBytes(seg.url);
          this.seenSeq.add(seg.seq);
          this.segments.push({
            seq: seg.seq,
            duration: seg.duration || this.targetDuration || 2,
            t: Date.now(),
            bytes
          });
          this.bytes += bytes.size;
          if (this.container !== "mp4" && /\.ts(\?|$)/.test(seg.url)) this.container = "ts";
        } catch {
          // A single missed segment is normal on live edge; keep going.
        }
      }
      this.#prune();

      if (playlist.endList) {
        this.onError("The stream ended.");
        this.stop();
        return;
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures++;
      // Live playlists rotate/expire; give up only after repeated failures.
      if (this.consecutiveFailures >= 6) {
        this.onError(`Lost the source stream (${e.message}).`);
        this.stop();
      }
    }
  }

  // 0 for either limit means unlimited — keep everything since monitoring
  // began. Segments are held as Blobs, so Chrome can page them out to disk
  // rather than pinning the JS heap, which is what makes very long buffers
  // practical at all.
  #prune() {
    const maxSeconds = scpBufferSeconds(this.settings);
    const maxBytes = (this.settings.maxBufferMB || 0) * 1024 * 1024;
    if (!maxSeconds && !maxBytes) return;

    let total = this.segments.reduce((a, s) => a + s.duration, 0);
    while (
      this.segments.length > 1 &&
      ((maxSeconds && total > maxSeconds) || (maxBytes && this.bytes > maxBytes))
    ) {
      const dropped = this.segments.shift();
      total -= dropped.duration;
      this.bytes -= dropped.bytes.size;
      this.seenSeq.delete(dropped.seq);
    }
  }

  async #fetchText(url) {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // Returns a Blob, not a typed array: Blob storage is managed by the browser
  // and can spill to disk, so a multi-hour buffer does not have to fit in RAM.
  async #fetchBytes(url) {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }
}

if (typeof globalThis !== "undefined") globalThis.ScpHlsBuffer = ScpHlsBuffer;
