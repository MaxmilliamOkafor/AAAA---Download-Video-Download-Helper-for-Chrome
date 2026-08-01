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
    this.initSegment = null;   // { url, bytes } for fMP4
    this.segments = [];        // [{ seq, duration, t, bytes: Uint8Array }]
    this.bytes = 0;
    this.seenSeq = new Set();
    this.startedAt = Date.now();
    this.stopped = false;
    this.pollTimer = null;
    this.consecutiveFailures = 0;
    this.container = "ts";     // ts | mp4
  }

  async start() {
    const text = await this.#fetchText(this.playlistUrl);
    if (scpIsMasterPlaylist(text)) {
      const variants = scpParseMasterPlaylist(text, this.playlistUrl);
      const cap = this.settings.sourceHeightCap || 0;
      this.variant = scpPickVariant(variants, cap);
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

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.segments = [];
    this.seenSeq.clear();
    this.bytes = 0;
  }

  stats() {
    const bufferedSeconds = this.segments.reduce((a, s) => a + s.duration, 0);
    return {
      mode: "source",
      bufferedSeconds: Math.round(bufferedSeconds),
      maxBufferSeconds: this.settings.bufferMinutes * 60,
      bufferedBytes: this.bytes,
      startedAt: this.startedAt,
      quality: this.variant
        ? `${this.variant.height}p${this.variant.frameRate ? Math.round(this.variant.frameRate) : ""}`
        : "source",
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

      const fresh = playlist.segments.filter(s => !this.seenSeq.has(s.seq));
      for (const seg of fresh) {
        if (this.stopped) return;
        try {
          const bytes = await this.#fetchBytes(seg.url);
          this.seenSeq.add(seg.seq);
          this.segments.push({
            seq: seg.seq,
            duration: seg.duration || this.targetDuration || 2,
            t: Date.now(),
            bytes
          });
          this.bytes += bytes.byteLength;
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

  #prune() {
    const maxSeconds = this.settings.bufferMinutes * 60;
    const maxBytes = this.settings.maxBufferMB * 1024 * 1024;
    let total = this.segments.reduce((a, s) => a + s.duration, 0);
    while (this.segments.length > 1 && (total > maxSeconds || this.bytes > maxBytes)) {
      const dropped = this.segments.shift();
      total -= dropped.duration;
      this.bytes -= dropped.bytes.byteLength;
      this.seenSeq.delete(dropped.seq);
    }
  }

  async #fetchText(url) {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  async #fetchBytes(url) {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

if (typeof globalThis !== "undefined") globalThis.ScpHlsBuffer = ScpHlsBuffer;
