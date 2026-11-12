// End-to-end, in real Chromium with the real extension loaded.
//
// A local server plays the part of a live channel: a page at a twitch.tv
// channel URL (mapped to localhost) requests its HLS playlists the way a
// player does, including a stitched ad. The test performs no extension
// action at all — it only opens pages — and asserts that monitoring,
// auto-clipping, ad removal, MP4 conversion and saving happen by themselves.
//
// Needs: playwright (with Chromium) and ffmpeg. Skips if either is missing.
// Run: node test/e2e/handsfree.e2e.js
const assert = require("assert");
const { spawnSync, execFileSync } = require("child_process");
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("  skipped: playwright not installed"); process.exit(0); }
if (spawnSync("ffmpeg", ["-version"]).status !== 0) { console.log("  skipped: ffmpeg not installed"); process.exit(0); }

const EXT = path.resolve(__dirname, "../..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "scp-e2e-"));
const STREAM = path.join(WORK, "stream"), DOWNLOADS = path.join(WORK, "downloads");
fs.mkdirSync(STREAM); fs.mkdirSync(DOWNLOADS);

const SEGMENTS = 20, AD = 6; // 2-second segments; one is advertised as an ad
execFileSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", String(SEGMENTS * 2), "-c:v", "libx264", "-preset", "ultrafast", "-g", "120", "-b:v", "6M", "-c:a", "aac",
  "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_segment_filename", path.join(STREAM, "seg%02d.ts"),
  path.join(STREAM, "ref.m3u8")], { stdio: "ignore" });

let t0 = 0; // when the current "broadcast" started
const PLAYER = `<html><head><title>chan - Twitch</title></head><body><script>
  fetch("/hls/master.m3u8").then(() => setInterval(() => fetch("/hls/live.m3u8"), 1000));
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/directory") { res.setHeader("Content-Type", "text/html"); res.end("<script>fetch('/hls/master.m3u8')</script>"); return; }
  if (url === "/alpha" || url === "/bravo") { res.setHeader("Content-Type", "text/html"); res.end(PLAYER); return; }
  if (url === "/hls/master.m3u8") {
    if (!t0) t0 = Date.now();
    // Lower rendition listed first: the extension must still pick the best.
    res.end(["#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d401f,mp4a.40.2"', "low.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=6200000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2"', "live.m3u8"].join("\n"));
    return;
  }
  if (url === "/hls/live.m3u8" || url === "/hls/low.m3u8") {
    const newest = Math.min(SEGMENTS - 1, 2 + Math.floor((Date.now() - t0) / 1000));
    const first = Math.max(0, newest - 4);
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (let i = first; i <= newest; i++) {
      if (i === AD) lines.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00Z",DURATION=2.000');
      lines.push("#EXTINF:2.000,", `seg${String(i).padStart(2, "0")}.ts`);
    }
    res.end(lines.join("\n"));
    return;
  }
  const file = path.join(STREAM, path.basename(url));
  if (fs.existsSync(file)) { res.end(fs.readFileSync(file)); return; }
  res.statusCode = 404; res.end();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = (file, entries, extra = []) => execFileSync("ffprobe",
  ["-v", "error", ...extra, "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();

let passed = 0;
const ok = name => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const ctx = await chromium.launchPersistentContext(path.join(WORK, "profile"), {
    channel: "chromium", headless: true, downloadsPath: DOWNLOADS, acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-proxy-server",
      `--host-resolver-rules=MAP www.twitch.tv 127.0.0.1:${server.address().port}`]
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const workerErrors = [];
    sw.on("console", m => { if (m.type() === "error") workerErrors.push(m.text()); });
    const state = () => sw.evaluate(async () => {
      await hydrate();
      const { clipHistory = [] } = await chrome.storage.local.get("clipHistory");
      const out = [];
      for (const s of sessions.values()) {
        const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "get-stats", tabId: s.tabId }).catch(() => null);
        out.push({ streamer: s.streamer, site: s.site, mode: s.mode, quality: s.quality, stats: r && r.stats });
      }
      return { sessions: out, clips: clipHistory.slice().reverse(), offscreen: await chrome.offscreen.hasDocument() };
    });

    await sleep(800);
    assert.ok(ctx.pages().some(p => p.url().endsWith("/dashboard/dashboard.html#live")));
    ok("first run opens the dashboard");

    const defaults = await sw.evaluate(() => scpLoadSettings());
    assert.deepStrictEqual(
      [defaults.autoMonitor, defaults.autoClipEnabled, defaults.outputFormat, defaults.sourceHeightCap, defaults.driveEnabled],
      [true, true, "mp4", 0, false]);
    ok("a fresh install is already hands-free, uncapped and MP4");

    const directory = await ctx.newPage();
    await directory.goto("http://www.twitch.tv/directory");
    await sleep(1500);
    assert.strictEqual((await state()).sessions.length, 0);
    await directory.close();
    ok("a non-channel page that loads a playlist starts nothing");

    t0 = 0;
    const page = await ctx.newPage();
    await page.goto("http://www.twitch.tv/alpha"); // the only user action
    await sleep(5000);
    let s = await state();
    assert.strictEqual(s.sessions.length, 1);
    assert.deepStrictEqual([s.sessions[0].streamer, s.sessions[0].site, s.sessions[0].mode, s.sessions[0].quality],
      ["alpha", "Twitch", "source", "1080p60"]);
    assert.deepStrictEqual(s.sessions[0].stats.variants.map(v => v.label), ["1080p60", "720p60"]);
    assert.strictEqual(s.sessions[0].stats.container, "mp4");
    assert.ok(s.sessions[0].stats.bufferedSeconds >= 4);
    ok("opening a live channel starts source capture at the best rendition, with no click");

    // Stand in for the segment interval elapsing, then run one scheduler tick.
    await sleep(4500);
    await sw.evaluate(async () => { for (const x of sessions.values()) { x.lastAutoClipAt = 1; x.startedAt = 1; } await runAutoClips(); });
    await sleep(2500);
    s = await state();
    assert.strictEqual(s.clips.length, 1);
    assert.ok(s.clips[0].auto && s.clips[0].local === "saved" && s.clips[0].filename.endsWith(".mp4"));
    assert.ok(s.sessions[0].stats.adSegmentsSkipped >= 1);
    ok("the scheduler saves an automatic MP4 clip, with the ad segment never downloaded");

    await sleep(3000);
    t0 = 0;
    await page.goto("http://www.twitch.tv/bravo");
    await sleep(6000);
    s = await state();
    assert.deepStrictEqual(s.sessions.map(x => x.streamer), ["bravo"]);
    assert.strictEqual(s.clips.length, 2);
    assert.ok(s.clips[1].filename.includes("/alpha "));
    ok("switching channel in the same tab saves the remainder and follows the new stream");

    await page.close();
    await sleep(4000);
    s = await state();
    assert.strictEqual(s.sessions.length, 0);
    assert.strictEqual(s.clips.length, 3);
    assert.ok(s.clips[2].filename.includes("/bravo "));
    assert.ok(s.clips.every(c => c.local === "saved"));
    assert.strictEqual(s.offscreen, false);
    ok("closing the tab saves what was left and releases the capture document");

    // Every second of alpha that was buffered is in exactly one clip.
    const alphaSeconds = s.clips.filter(c => c.filename.includes("/alpha ")).reduce((a, c) => a + c.lengthSeconds, 0);
    assert.ok(alphaSeconds >= 18 && alphaSeconds % 2 === 0, `alpha clips total ${alphaSeconds}s`);
    ok("automatic clips tile the stream without overlap");

    const files = fs.readdirSync(DOWNLOADS).map(f => path.join(DOWNLOADS, f));
    assert.strictEqual(files.length, 3);
    for (const file of files) {
      assert.strictEqual(probe(file, "stream=codec_name,width,height", ["-select_streams", "v"]), "h264,1920,1080");
      assert.ok(probe(file, "format=format_name").includes("mp4"));
      assert.strictEqual(spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]).stderr.toString().trim(), "");
      const pts = probe(file, "packet=pts_time", ["-select_streams", "v"]).split("\n").map(Number).sort((a, b) => a - b);
      assert.ok(Math.max(...pts.slice(1).map((t, i) => t - pts[i])) < 0.02, "continuous playback");
    }
    ok("the saved files are valid 1080p H.264 MP4s that play straight through");

    assert.deepStrictEqual(workerErrors, []);
    ok("no errors in the service worker");
    console.log(`\n${passed} end-to-end checks passed`);
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); server.close(); process.exit(1); });
