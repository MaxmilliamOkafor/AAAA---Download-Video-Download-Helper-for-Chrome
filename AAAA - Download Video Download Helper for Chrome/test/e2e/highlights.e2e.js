// End-to-end: highlights from chat, delivered to a shorts engine.
//
// Real Chromium with the real extension. A local server plays a live channel
// at a twitch.tv URL; its page carries a chat list that the page's own script
// fills like Twitch's does — ordinary chat for 85 seconds, then 8 seconds of
// "OMEGALUL" and "CLIP IT", then ordinary chat again. A second local server
// imitates OpenShorts' /api/process. The test only opens the page, then
// asserts that a highlight was detected, saved as a valid MP4 in the
// Highlights folder, and handed to the engine with the rights flag.
//
// About two and a half minutes (the detector learns the chat's pace for a
// minute first). Needs playwright and ffmpeg; skips without them.
// Run: node test/e2e/highlights.e2e.js
const assert = require("assert");
const { spawnSync, execFileSync } = require("child_process");
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("  skipped: playwright not installed"); process.exit(0); }
if (spawnSync("ffmpeg", ["-version"]).status !== 0) { console.log("  skipped: ffmpeg not installed"); process.exit(0); }

const EXT = path.resolve(__dirname, "../..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "scp-hl-"));
const STREAM = path.join(WORK, "stream"), DOWNLOADS = path.join(WORK, "downloads");
fs.mkdirSync(STREAM); fs.mkdirSync(DOWNLOADS);

const SEGMENTS = 120; // 2-second segments, published in real time like a live stream
execFileSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", String(SEGMENTS * 2), "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-b:v", "1500k", "-c:a", "aac",
  "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_segment_filename", path.join(STREAM, "seg%03d.ts"),
  path.join(STREAM, "ref.m3u8")], { stdio: "ignore" });

const BURST_AT = 85, BURST_FOR = 8;
const PAGE = `<html><head><title>alpha - Twitch</title></head><body>
<div class="chat-scrollable-area__message-container"></div>
<script>
  fetch("/hls/master.m3u8").then(() => setInterval(() => fetch("/hls/live.m3u8"), 1000));
  const list = document.querySelector(".chat-scrollable-area__message-container");
  const chatter = ["what game is this", "hi from spain", "he should go left", "nice setup", "how long is stream", "first time here"];
  const hype = ["OMEGALUL", "CLIP IT", "LMAOOO", "KEKW KEKW", "NO WAY", "clip that", "WWWWW"];
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const started = Date.now();
  function say(text) {
    const line = document.createElement("div");
    line.className = "chat-line__message";
    line.innerHTML = '<span data-a-target="chat-message-text"></span>';
    line.firstChild.textContent = text;
    list.append(line);
  }
  setInterval(() => {
    const t = (Date.now() - started) / 1000;
    const burst = t >= ${BURST_AT} && t < ${BURST_AT + BURST_FOR};
    const n = burst ? 14 + Math.floor(rnd() * 4) : Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) say(burst ? hype[Math.floor(rnd() * hype.length)] : chatter[Math.floor(rnd() * chatter.length)]);
  }, 1000);
</script></body></html>`;

let t0 = 0;
const stream = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/alpha") { res.setHeader("Content-Type", "text/html"); res.end(PAGE); return; }
  if (url === "/hls/master.m3u8") {
    if (!t0) t0 = Date.now();
    res.end(["#EXTM3U", '#EXT-X-STREAM-INF:BANDWIDTH=1700000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.64001f,mp4a.40.2"', "live.m3u8"].join("\n"));
    return;
  }
  if (url === "/hls/live.m3u8") {
    const newest = Math.min(SEGMENTS - 1, 2 + Math.floor((Date.now() - t0) / 2000));
    const first = Math.max(0, newest - 4);
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (let i = first; i <= newest; i++) lines.push("#EXTINF:2.000,", `seg${String(i).padStart(3, "0")}.ts`);
    res.end(lines.join("\n"));
    return;
  }
  const file = path.join(STREAM, path.basename(url));
  if (fs.existsSync(file)) { res.end(fs.readFileSync(file)); return; }
  res.statusCode = 404; res.end();
});

// Imitation of OpenShorts' upload endpoint: records what it was sent.
const received = [];
const engine = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/docs") { res.end("docs"); return; }
  if (req.method === "POST" && req.url === "/api/process") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const boundary = /boundary=(.+)$/.exec(req.headers["content-type"])[1];
      const parts = body.toString("latin1").split("--" + boundary).slice(1, -1);
      const fields = {};
      for (const part of parts) {
        const [head, ...rest] = part.split("\r\n\r\n");
        const name = /name="([^"]+)"/.exec(head)[1];
        const value = rest.join("\r\n\r\n").replace(/\r\n$/, "");
        fields[name] = /filename="/.test(head) ? { filename: /filename="([^"]+)"/.exec(head)[1], bytes: Buffer.byteLength(value, "latin1") } : value;
      }
      received.push({ fields, geminiKey: req.headers["x-gemini-key"] || null });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ job_id: `job-${received.length}`, status: "queued" }));
    });
    return;
  }
  res.statusCode = 404; res.end();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = name => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  await new Promise(r => stream.listen(0, "127.0.0.1", r));
  await new Promise(r => engine.listen(0, "127.0.0.1", r));
  const enginePort = engine.address().port;
  const ctx = await chromium.launchPersistentContext(path.join(WORK, "profile"), {
    channel: "chromium", headless: true, downloadsPath: DOWNLOADS, acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-proxy-server",
      `--host-resolver-rules=MAP www.twitch.tv 127.0.0.1:${stream.address().port}`]
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const workerErrors = [];
    sw.on("console", m => { if (m.type() === "error") workerErrors.push(m.text()); });

    // The user's choices, as the dashboard would store them.
    await sw.evaluate(async base => {
      const s = await scpLoadSettings();
      await scpSaveSettings({ ...s, shortsEngine: "openshorts", shortsEngineUrl: base, shortsRightsConfirmed: true });
      await chrome.storage.local.set({ shortsEngineKey: "test-gemini-key" });
    }, `http://127.0.0.1:${enginePort}`);
    const test = await sw.evaluate(() => testShortsEngine());
    assert.strictEqual(test.ok, true, JSON.stringify(test));
    ok("connection test reaches the engine");

    const page = await ctx.newPage();
    await page.goto("http://www.twitch.tv/alpha");

    const stats = () => sw.evaluate(async () => {
      await hydrate();
      const [s] = [...sessions.values()];
      if (!s) return null;
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "get-stats", tabId: s.tabId }).catch(() => null);
      return r && r.stats && r.stats.highlights;
    });

    await sleep(30000);
    let hl = await stats();
    assert.ok(hl && hl.chatFound && hl.chatActive, JSON.stringify(hl));
    assert.ok(hl.messagesPerMinute > 20 && hl.messagesPerMinute < 120, `msg/min ${hl.messagesPerMinute}`);
    assert.strictEqual(hl.warm, false);
    assert.strictEqual(hl.highlightCount, 0);
    ok("chat is read on the page and its pace is measured while it learns");

    await sleep((BURST_AT - 22) * 1000);
    hl = await stats();
    assert.strictEqual(hl.warm, true);
    assert.strictEqual(hl.highlightCount, 0, "no false highlight from ordinary chat");
    ok("85 seconds of ordinary chat produce no highlight");

    // The burst, the quiet that ends it, the post-roll and assembly.
    let clip = null;
    for (let i = 0; i < 40 && !clip; i++) {
      await sleep(1000);
      const { clipHistory = [] } = await sw.evaluate(() => chrome.storage.local.get("clipHistory"));
      clip = clipHistory.find(c => c.kind === "highlight" && c.local === "saved");
    }
    if (!clip) {
      const { clipHistory = [] } = await sw.evaluate(() => chrome.storage.local.get("clipHistory"));
      throw new Error("no highlight saved; stats=" + JSON.stringify(await stats()) + " history=" + JSON.stringify(clipHistory));
    }
    assert.ok(clip.highlightScore >= 30, `score ${clip.highlightScore}`);
    assert.ok(/\/Highlights\/alpha - .* \(highlight \d+\)\.mp4$/.test(clip.filename), clip.filename);
    ok(`the burst becomes a highlight clip (score ${clip.highlightScore}) in the Highlights folder`);

    for (let i = 0; i < 20; i++) {
      const { clipHistory = [] } = await sw.evaluate(() => chrome.storage.local.get("clipHistory"));
      clip = clipHistory.find(c => c.clipId === clip.clipId);
      if (clip.engine !== "sending") break;
      await sleep(500);
    }
    assert.strictEqual(clip.engine, "sent", JSON.stringify(clip));
    assert.strictEqual(clip.engineJobId, "job-1");
    assert.strictEqual(received.length, 1);
    const sent = received[0];
    assert.strictEqual(sent.fields.acknowledged, "true");
    assert.strictEqual(sent.geminiKey, "test-gemini-key");
    assert.strictEqual(sent.fields.file.bytes, clip.sizeBytes);
    assert.ok(sent.fields.file.filename.endsWith(".mp4"));
    ok("the highlight is handed to OpenShorts with the rights flag and key, and the job is recorded");

    const [file] = fs.readdirSync(DOWNLOADS).map(f => path.join(DOWNLOADS, f));
    const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
    // pre-roll 25s + burst ~8-15s + post-roll 8s, on 2-second segment edges
    assert.ok(duration >= 36 && duration <= 60, `duration ${duration}`);
    assert.ok(Math.abs(duration - clip.lengthSeconds) <= 2, `file ${duration}s vs recorded ${clip.lengthSeconds}s`);
    assert.strictEqual(spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]).stderr.toString().trim(), "");
    ok(`the saved file is a valid ${Math.round(duration)}s MP4 covering the run-up, the burst and the aftermath`);

    assert.deepStrictEqual(workerErrors, []);
    ok("no errors in the service worker");
    console.log(`\n${passed} highlight end-to-end checks passed`);
  } finally {
    await ctx.close();
    stream.close();
    engine.close();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); stream.close(); engine.close(); process.exit(1); });
