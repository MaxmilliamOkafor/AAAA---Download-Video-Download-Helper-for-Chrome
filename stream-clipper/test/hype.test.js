// Tests for the chat highlight detector. Run: node test/hype.test.js
const assert = require("assert");
const {
  ScpHypeDetector, scpClassifyChat, scpHighlightWindow, scpAllowHighlight
} = require("../shared/hype.js");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// Deterministic pseudo-random chat, so tests are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function quietChat(seconds, { base = 1.5, seed = 7, start = 0 } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < seconds; i++) {
    const messages = Math.round(base * 2 * r());
    out.push({ t: start + i, messages, hype: r() < 0.08 ? 1 : 0, clipCalls: 0 });
  }
  return out;
}
function run(detector, samples) {
  const events = [];
  for (const s of samples) {
    const e = detector.push(s);
    if (e) events.push(e);
  }
  return events;
}

test("classifies reactions, emotes, shouting and clip requests", () => {
  for (const t of ["LMAOOOO", "OMEGALUL", "KEKW KEKW", "W", "WWWWWW", "no way 💀", "🔥🔥", "WHAT WAS THAT", "lol"]) {
    assert.strictEqual(scpClassifyChat(t).hype, true, t);
  }
  for (const t of ["clip it", "CLIP THAT", "clippp it!!", "clip"]) {
    assert.deepStrictEqual(scpClassifyChat(t), { hype: true, clipCall: true }, t);
  }
  for (const t of ["what game is this", "hello from brazil", "he said the elevator works", "eclipse is tonight"]) {
    assert.deepStrictEqual(scpClassifyChat(t), { hype: false, clipCall: false }, t);
  }
});

test("stays silent on ten minutes of ordinary chat", () => {
  const d = new ScpHypeDetector({ sensitivity: "high" });
  assert.deepStrictEqual(run(d, quietChat(600)), []);
});

test("does not fire during warm-up, however loud", () => {
  const d = new ScpHypeDetector();
  const loud = Array.from({ length: 50 }, (_, i) => ({ t: i, messages: 20, hype: 15, clipCalls: 2 }));
  assert.deepStrictEqual(run(d, loud), []);
});

test("finds a burst with the right start, peak and end", () => {
  const d = new ScpHypeDetector();
  const samples = quietChat(180);
  // t=180..194: chat explodes, peaking at t=186, then returns to normal.
  for (let i = 0; i < 15; i++) {
    const level = i < 6 ? 4 + i * 3 : Math.max(2, 22 - (i - 6) * 3);
    samples.push({ t: 180 + i, messages: level, hype: Math.round(level * 0.8), clipCalls: i === 5 || i === 6 ? 2 : 0 });
  }
  samples.push(...quietChat(60, { start: 195, seed: 99 }));
  const events = run(d, samples);
  assert.strictEqual(events.length, 1, JSON.stringify(events));
  const [e] = events;
  assert.ok(e.start >= 176 && e.start <= 184, `start ${e.start}`);
  assert.ok(e.peak >= 184 && e.peak <= 190, `peak ${e.peak}`);
  assert.ok(e.end >= 188 && e.end <= 200, `end ${e.end}`);
  assert.ok(e.score >= 50 && e.score <= 100, `score ${e.score}`);
  assert.ok(e.clipCalls >= 4);
});

test("is relative to the channel: a big chat's normal pace is not a highlight", () => {
  const d = new ScpHypeDetector();
  // A large channel chatting steadily at ~25 messages a second.
  const busy = Array.from({ length: 400 }, (_, i) => ({ t: i, messages: 22 + (i % 7), hype: 4 + (i % 3), clipCalls: 0 }));
  assert.deepStrictEqual(run(d, busy), []);
  // ...but a real spike in that same chat still registers.
  const spike = Array.from({ length: 12 }, (_, i) => ({ t: 400 + i, messages: 70, hype: 55, clipCalls: 3 }));
  const after = Array.from({ length: 30 }, (_, i) => ({ t: 412 + i, messages: 24, hype: 4, clipCalls: 0 }));
  assert.strictEqual(run(d, [...spike, ...after]).length, 1);
});

test("a small channel's spike counts even though the numbers are low", () => {
  const d = new ScpHypeDetector({ sensitivity: "high" });
  const samples = quietChat(120, { base: 0.3 });
  for (let i = 0; i < 8; i++) samples.push({ t: 120 + i, messages: 3, hype: 3, clipCalls: i === 2 ? 1 : 0 });
  samples.push(...quietChat(40, { base: 0.3, start: 128, seed: 3 }));
  assert.strictEqual(run(d, samples).length, 1);
});

test("one long celebration is one highlight, and cooldown blocks an echo", () => {
  const d = new ScpHypeDetector({ maxEventSeconds: 60 });
  const samples = quietChat(120);
  for (let i = 0; i < 40; i++) samples.push({ t: 120 + i, messages: 15, hype: 12, clipCalls: 0 });
  // A brief echo right after the cooldown boundary would be suppressed.
  samples.push(...quietChat(10, { start: 160, seed: 5 }));
  for (let i = 0; i < 5; i++) samples.push({ t: 170 + i, messages: 15, hype: 12, clipCalls: 0 });
  samples.push(...quietChat(20, { start: 175, seed: 6 }));
  const events = run(d, samples);
  assert.strictEqual(events.length, 1, JSON.stringify(events));
  assert.ok(events[0].end - events[0].start >= 30);
});

test("a gap in samples resets the window instead of reading as silence", () => {
  const d = new ScpHypeDetector();
  run(d, quietChat(120));
  d.push({ t: 120, messages: 30, hype: 20, clipCalls: 0 });
  // Tab asleep for a minute, then ordinary chat.
  const events = run(d, quietChat(30, { start: 180, seed: 11 }));
  assert.ok(events.length <= 1);
  assert.strictEqual(d.snapshot().inBurst, false);
});

test("flush closes a burst that is still open", () => {
  const d = new ScpHypeDetector();
  run(d, quietChat(120));
  run(d, Array.from({ length: 6 }, (_, i) => ({ t: 120 + i, messages: 20, hype: 15, clipCalls: 1 })));
  assert.strictEqual(d.snapshot().inBurst, true);
  const e = d.flush(126);
  assert.ok(e && e.start <= 121 && e.end >= 124);
  assert.strictEqual(d.flush(130), null);
});

test("clip window opens before the reaction and runs past it", () => {
  const w = scpHighlightWindow({ start: 100, end: 110 }, { preRoll: 25, postRoll: 8 });
  assert.deepStrictEqual(w, { since: 75000, until: 118000 });
});

test("hourly cap keeps the best highlights", () => {
  const recent = [{ end: 1000, score: 40 }, { end: 2000, score: 70 }];
  assert.strictEqual(scpAllowHighlight(recent, { end: 2500, score: 30 }, 3), true);
  assert.strictEqual(scpAllowHighlight(recent, { end: 2500, score: 30 }, 2), false);
  assert.strictEqual(scpAllowHighlight(recent, { end: 2500, score: 60 }, 2), true);
  assert.strictEqual(scpAllowHighlight(recent, { end: 5000, score: 10 }, 2), true, "older than an hour");
  assert.strictEqual(scpAllowHighlight(recent, { end: 2500, score: 1 }, 0), true, "0 = no cap");
});

console.log(`\n${passed} highlight detector tests passed`);
