// Remuxes real MPEG-TS segments (made with ffmpeg) to MP4 and checks the
// result with ffprobe. Skips when ffmpeg is not installed.
// Run: node test/ts-to-mp4.test.js
const assert = require("assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.log("  skipped: ffmpeg not installed");
  process.exit(0);
}
// The vendored bundle is the browser build: load it the way a page would,
// as a global, rather than through require().
globalThis.window = globalThis;
new Function(fs.readFileSync(path.join(__dirname, "../vendor/mux-mp4.min.js"), "utf8"))();
const muxjs = globalThis.muxjs;
const { scpRemuxTsToMp4 } = require("../offscreen/ts-to-mp4.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scp-remux-"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();

run("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "120", "-c:a", "aac", "-f", "hls", "-hls_time", "2",
  "-hls_list_size", "0", "-hls_segment_filename", "seg%d.ts", "ref.m3u8"]);

const segment = i => ({ seq: i, duration: 2, bytes: new Uint8Array(fs.readFileSync(path.join(dir, `seg${i}.ts`))) });
const write = (name, parts) => fs.writeFileSync(path.join(dir, name),
  Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
const frames = file => Number(run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v",
  "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).trim());
const duration = file => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
const decodeErrors = file => spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { cwd: dir }).stderr.toString().trim();
const maxGap = file => {
  const pts = run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file])
    .trim().split("\n").map(Number).sort((a, b) => a - b);
  return Math.max(...pts.slice(1).map((t, i) => t - pts[i]));
};
// Decoded-frame checksums of the video stream: equal means no re-encode.
const videoHash = file => run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"])
  .split("\n").filter(l => l && !l.startsWith("#")).map(l => l.split(",").pop().trim()).join("");

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

(async () => {
  fs.writeFileSync(path.join(dir, "all.ts"), Buffer.concat([0, 1, 2, 3, 4, 5].map(i => fs.readFileSync(path.join(dir, `seg${i}.ts`)))));

  await test("contiguous segments become a valid MP4 with every frame", async () => {
    const out = await scpRemuxTsToMp4([0, 1, 2, 3, 4, 5].map(segment), muxjs);
    write("full.mp4", out.parts);
    assert.strictEqual(out.durationSeconds, 12);
    assert.strictEqual(frames("full.mp4"), 720);
    assert.ok(Math.abs(duration("full.mp4") - 12) < 0.1);
    assert.strictEqual(decodeErrors("full.mp4"), "");
  });

  await test("video is bit-identical to the source (no re-encode)", () => {
    assert.strictEqual(videoHash("full.mp4"), videoHash("all.ts"));
  });

  await test("a removed stretch (skipped ad) leaves no gap in the timeline", async () => {
    const out = await scpRemuxTsToMp4([0, 1, 4, 5].map(segment), muxjs);
    write("gap.mp4", out.parts);
    assert.strictEqual(frames("gap.mp4"), 480);
    assert.ok(Math.abs(duration("gap.mp4") - 8) < 0.1);
    assert.ok(maxGap("gap.mp4") < 0.02, "no jump larger than one frame");
    assert.strictEqual(decodeErrors("gap.mp4"), "");
  });

  await test("rejects empty input and non-media bytes", async () => {
    await assert.rejects(scpRemuxTsToMp4([], muxjs));
    await assert.rejects(scpRemuxTsToMp4([{ seq: 0, duration: 2, bytes: new Uint8Array(4096) }], muxjs));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} TS-to-MP4 tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
