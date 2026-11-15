// Live highlight detection from chat.
//
// The idea comes from OpenShorts (MIT, github.com/mutonby/openshorts):
// on streams, what viewers react to finds moments a transcript misses — a
// chase, a crash or a clutch play is often a scream and twelve seconds of
// nobody talking. OpenShorts reads that signal from the clips viewers cut
// from a finished VOD. A live stream has no clips yet, but it has chat, and
// chat reacts within seconds. This module turns per-second chat activity
// into highlight events: a burst well above the channel's own recent
// baseline, scored, with a start, a peak and an end.
//
// Pure and standard-library only, so it runs in the offscreen document and in
// Node tests alike. Time is passed in, never read from a clock.

// Words and emotes that mark a reaction rather than conversation. Matched as
// whole tokens, case-insensitively. Emotes reach us as their alt text.
const SCP_HYPE_TERMS = new Set([
  "lol", "lmao", "lmfao", "rofl", "omg", "wtf", "wow", "holy", "insane",
  "sheesh", "goat", "goated", "clutch", "pog", "pogs", "poggers", "pogchamp",
  "pogu", "kekw", "kek", "lul", "lulw", "omegalul", "icant", "aware", "monkas",
  "pepelaugh", "ez", "gg", "w", "ww", "www", "wwww", "l", "noway", "ayo",
  "hype", "letsgo", "lets", "gooo", "goooo", "nooo", "noooo", "bruh", "bro",
  "+2", "+1", "kappa", "monkaw", "pausechamp", "catjam"
]);
const SCP_HYPE_EMOJI = /[\u{1F602}\u{1F923}\u{1F480}\u{1F525}\u{1F631}\u{1F633}\u{1F92F}\u{1F62D}\u{2757}\u{203C}]/u;
// Viewers asking for a clip is the most direct signal there is.
const SCP_CLIP_CALL = /\bclip+\s*(it|that|this|dat)\b|\bclip+ed?\b|\bclipp?\s*!|^clip\b/i;

// Classifies one chat message. Returns { hype, clipCall }.
function scpClassifyChat(text) {
  const raw = String(text || "");
  const clipCall = SCP_CLIP_CALL.test(raw);
  if (clipCall) return { hype: true, clipCall: true };
  if (SCP_HYPE_EMOJI.test(raw)) return { hype: true, clipCall: false };
  const tokens = raw.toLowerCase().replace(/[^\p{L}\p{N}+]+/gu, " ").trim().split(/\s+/);
  for (const token of tokens) {
    // Collapse letter repeats so "LMAOOOO" and "WWWWWW" still match.
    const squashed = token.replace(/(.)\1{2,}/g, "$1$1");
    if (SCP_HYPE_TERMS.has(token) || SCP_HYPE_TERMS.has(squashed) || SCP_HYPE_TERMS.has(token.replace(/(.)\1+/g, "$1"))) {
      return { hype: true, clipCall: false };
    }
  }
  // Shouting reads as a reaction too ("NO WAY", "WHAT").
  const letters = raw.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) return { hype: true, clipCall: false };
  return { hype: false, clipCall: false };
}

// One second of chat is worth: every message 1, a reaction 2 more, a clip
// request 6 more. A quiet chat of people talking scores low; a wall of
// "OMEGALUL" and "CLIP IT" scores high even in a small channel.
function scpChatScore(sample) {
  return (sample.messages || 0) + 2 * (sample.hype || 0) + 6 * (sample.clipCalls || 0);
}

// A burst must clear three bars at once: k standard deviations above the
// baseline (statistically unusual), `ratio` times the baseline (a real jump,
// not noise in a busy chat) and an absolute floor (a dead chat's single
// "lol" is not a highlight). It must also hold for `confirm` seconds, because
// overlapping 5-second windows make noise peaks arrive in clusters.
const SCP_SENSITIVITY = {
  low:    { k: 4.0, ratio: 3.0, floor: 30, confirm: 3 },
  medium: { k: 3.0, ratio: 2.5, floor: 18, confirm: 2 },
  high:   { k: 2.8, ratio: 2.2, floor: 15, confirm: 3 }
};

// Streaming burst detector over per-second chat samples.
//
//   const d = new ScpHypeDetector({ sensitivity: "medium" });
//   for each second: const event = d.push({ t, messages, hype, clipCalls });
//   event, when not null: { start, peak, end, score, peakRate, clipCalls }
//
// The baseline is an exponentially weighted mean and variance of a 5-second
// rolling window, updated only while no burst is in progress, so a long
// highlight does not raise the bar for itself.
class ScpHypeDetector {
  constructor({
    sensitivity = "medium",
    windowSeconds = 5,
    warmupSeconds = 60,
    baselineSeconds = 120,
    quietSeconds = 6,
    maxEventSeconds = 90,
    cooldownSeconds = 30
  } = {}) {
    const preset = SCP_SENSITIVITY[sensitivity] || SCP_SENSITIVITY.medium;
    this.k = preset.k;
    this.ratio = preset.ratio;
    this.floor = preset.floor;
    this.confirm = preset.confirm;
    this.above = 0;         // consecutive seconds over the threshold
    this.windowSeconds = windowSeconds;
    this.warmupSeconds = warmupSeconds;
    this.alpha = 2 / (baselineSeconds + 1);
    this.quietSeconds = quietSeconds;
    this.maxEventSeconds = maxEventSeconds;
    this.cooldownSeconds = cooldownSeconds;

    this.window = [];       // last windowSeconds of { t, score, clipCalls }
    this.mean = null;
    this.variance = 0;
    this.seen = 0;          // seconds of baseline collected
    this.event = null;      // burst in progress
    this.cooldownUntil = -Infinity;
    this.lastT = null;
  }

  // Current threshold for the rolling window's score.
  threshold() {
    if (this.mean == null) return Infinity;
    const sd = Math.sqrt(Math.max(this.variance, 1));
    return Math.max(this.floor, this.mean + this.k * sd, this.ratio * this.mean);
  }

  // State for display: is it warmed up, what is the current level.
  snapshot() {
    const windowScore = this.window.reduce((a, s) => a + s.score, 0);
    return {
      warm: this.seen >= this.warmupSeconds,
      windowScore,
      threshold: this.threshold(),
      baseline: this.mean == null ? 0 : this.mean,
      inBurst: !!this.event
    };
  }

  push(sample) {
    const t = Number(sample.t);
    if (!Number.isFinite(t)) return null;
    // Samples are one per second; a long gap (tab asleep, chat hidden)
    // invalidates the rolling window rather than reading as silence.
    if (this.lastT != null && t - this.lastT > 10) {
      this.window = [];
      this.above = 0;
    }
    this.lastT = t;

    const score = scpChatScore(sample);
    this.window.push({ t, score, clipCalls: sample.clipCalls || 0, messages: sample.messages || 0 });
    while (this.window.length && this.window[0].t <= t - this.windowSeconds) this.window.shift();
    const windowScore = this.window.reduce((a, s) => a + s.score, 0);

    if (this.event) return this.#continueEvent(t, windowScore);

    const warm = this.seen >= this.warmupSeconds;
    const over = warm && t >= this.cooldownUntil && windowScore > this.threshold();
    this.above = over ? this.above + 1 : 0;
    if (over && this.above < this.confirm) return null; // hold the baseline still
    if (over) {
      this.above = 0;
      // The burst began where the window began rising: its first sample.
      this.event = {
        start: this.window[0].t,
        peak: t,
        peakScore: windowScore,
        lastHot: t,
        clipCalls: this.window.reduce((a, s) => a + s.clipCalls, 0),
        excess: windowScore - this.threshold(),
        threshold: this.threshold()
      };
      return null;
    }
    this.#learn(windowScore);
    return null;
  }

  // Flushes a burst that is still open (stream ended, capture stopped).
  flush(t) {
    if (!this.event) return null;
    return this.#finish(Number.isFinite(t) ? t : this.event.lastHot);
  }

  // During warm-up the baseline is an exact running mean and variance
  // (Welford), so its first values are not skewed by whichever second came
  // first; after that it becomes an exponentially weighted one that follows
  // the channel as its chat speeds up or slows down.
  #learn(windowScore) {
    if (this.window.length < this.windowSeconds) return; // partial window
    this.seen += 1;
    if (this.seen <= this.warmupSeconds) {
      const prevMean = this.mean == null ? 0 : this.mean;
      this.mean = prevMean + (windowScore - prevMean) / this.seen;
      this.m2 = (this.m2 || 0) + (windowScore - prevMean) * (windowScore - this.mean);
      this.variance = this.seen > 1 ? this.m2 / (this.seen - 1) : 0;
      return;
    }
    const diff = windowScore - this.mean;
    this.mean += this.alpha * diff;
    this.variance = (1 - this.alpha) * (this.variance + this.alpha * diff * diff);
  }

  #continueEvent(t, windowScore) {
    const e = this.event;
    const last = this.window[this.window.length - 1];
    e.clipCalls += last.clipCalls;
    if (windowScore > e.peakScore) {
      e.peakScore = windowScore;
      e.peak = t;
    }
    if (windowScore > e.threshold * 0.6) {
      e.lastHot = t;
      e.excess += Math.max(0, windowScore - e.threshold);
    }
    const quietFor = t - e.lastHot;
    if (quietFor >= this.quietSeconds || t - e.start >= this.maxEventSeconds) {
      return this.#finish(e.lastHot);
    }
    return null;
  }

  #finish(end) {
    const e = this.event;
    this.event = null;
    this.cooldownUntil = end + this.cooldownSeconds;
    // 0–100: how far above the bar the burst went, and how long it held,
    // with clip requests counting strongly. Saturates rather than overflows.
    const intensity = e.peakScore / Math.max(e.threshold, 1);
    // Twice the bar ≈ 30, four times ≈ 60, eight times ≈ 90 before the
    // duration and clip-request bonuses.
    const raw = 30 * Math.log2(Math.max(1, intensity)) +
      Math.min(20, (end - e.start)) +
      Math.min(20, e.clipCalls * 4);
    return {
      start: e.start,
      peak: e.peak,
      end,
      score: Math.max(1, Math.min(100, Math.round(raw))),
      peakRate: e.peakScore / this.windowSeconds,
      clipCalls: e.clipCalls
    };
  }
}

// Where a highlight clip should begin and end. Chat reacts a few seconds
// after the moment it reacts to, so the clip opens well before the burst.
function scpHighlightWindow(event, { preRoll = 25, postRoll = 8 } = {}) {
  return {
    since: (event.start - preRoll) * 1000,
    until: (event.end + postRoll) * 1000
  };
}

// Caps how many highlights one stream can produce per hour, keeping the best:
// returns true when `event` may be saved given the recent saved events.
function scpAllowHighlight(recent, event, maxPerHour) {
  if (!maxPerHour) return true;
  const hourAgo = event.end - 3600;
  const inLastHour = recent.filter(r => r.end > hourAgo);
  if (inLastHour.length < maxPerHour) return true;
  // At the cap, a highlight still gets through if it beats the weakest one.
  return event.score > Math.min(...inLastHour.map(r => r.score));
}

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    ScpHypeDetector, scpClassifyChat, scpChatScore, scpHighlightWindow, scpAllowHighlight
  });
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ScpHypeDetector, scpClassifyChat, scpChatScore, scpHighlightWindow, scpAllowHighlight };
}
