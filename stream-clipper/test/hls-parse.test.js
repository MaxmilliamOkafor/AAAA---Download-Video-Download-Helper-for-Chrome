// Unit tests for the HLS playlist parser. Run: node test/hls-parse.test.js
const assert = require("assert");
const {
  scpParseMasterPlaylist,
  scpParseMediaPlaylist,
  scpIsMasterPlaylist,
  scpPickVariant
} = require("../shared/hls-parse.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// --- master playlist: variant discovery and best-first ordering ---
const master = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d401f,mp4a.40.2"',
  "https://cdn.example/720p60/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2"',
  "1080p60/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,FRAME-RATE=30.000',
  "480p30/index.m3u8"
].join("\n");

test("detects a master playlist", () => {
  assert.strictEqual(scpIsMasterPlaylist(master), true);
});

test("parses variants and sorts best-first", () => {
  const v = scpParseMasterPlaylist(master, "https://cdn.example/base/playlist.m3u8");
  assert.strictEqual(v.length, 3);
  assert.strictEqual(v[0].height, 1080);
  assert.strictEqual(v[0].frameRate, 60);
  assert.strictEqual(v[1].height, 720);
  assert.strictEqual(v[2].height, 480);
});

test("resolves relative and absolute variant URIs", () => {
  const v = scpParseMasterPlaylist(master, "https://cdn.example/base/playlist.m3u8");
  assert.strictEqual(v[0].url, "https://cdn.example/base/1080p60/index.m3u8");
  assert.strictEqual(v[1].url, "https://cdn.example/720p60/index.m3u8");
});

test("handles quoted attribute values containing commas", () => {
  const v = scpParseMasterPlaylist(master, "https://cdn.example/x.m3u8");
  assert.strictEqual(v[0].codecs, "avc1.64002a,mp4a.40.2");
  assert.strictEqual(v[0].bandwidth, 8000000);
});

test("picks best variant, and respects a height cap", () => {
  const v = scpParseMasterPlaylist(master, "https://cdn.example/x.m3u8");
  assert.strictEqual(scpPickVariant(v, 0).height, 1080);
  assert.strictEqual(scpPickVariant(v, 1080).height, 1080);
  assert.strictEqual(scpPickVariant(v, 720).height, 720);
  assert.strictEqual(scpPickVariant(v, 240).height, 480); // nothing fits: take smallest
  assert.strictEqual(scpPickVariant([], 1080), null);
});

// --- media playlist: live sliding window (Twitch/Kick style, MPEG-TS) ---
const liveTs = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:1471",
  "#EXTINF:2.000,",
  "seg1471.ts",
  "#EXTINF:2.000,",
  "seg1472.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:1.500,",
  "https://other.cdn/seg1473.ts"
].join("\n");

test("is not misdetected as a master playlist", () => {
  assert.strictEqual(scpIsMasterPlaylist(liveTs), false);
});

test("parses live media playlist segments with correct sequence numbers", () => {
  const p = scpParseMediaPlaylist(liveTs, "https://cdn.example/live/index.m3u8");
  assert.strictEqual(p.targetDuration, 2);
  assert.strictEqual(p.mediaSequence, 1471);
  assert.strictEqual(p.endList, false);
  assert.strictEqual(p.segments.length, 3);
  assert.deepStrictEqual(p.segments.map(s => s.seq), [1471, 1472, 1473]);
  assert.strictEqual(p.segments[0].url, "https://cdn.example/live/seg1471.ts");
  assert.strictEqual(p.segments[2].url, "https://other.cdn/seg1473.ts");
  assert.strictEqual(p.segments[2].duration, 1.5);
  assert.strictEqual(p.initSegmentUrl, null);
});

test("ignores unknown tags without consuming segment lines", () => {
  const p = scpParseMediaPlaylist(liveTs, "https://cdn.example/live/index.m3u8");
  // The #EXT-X-DISCONTINUITY between segments must not drop seg1473.
  assert.strictEqual(p.segments.length, 3);
});

// --- media playlist: fMP4 with an init segment (#EXT-X-MAP) ---
const fmp4 = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:90",
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:4.000,",
  "seg90.m4s",
  "#EXTINF:4.000,",
  "seg91.m4s"
].join("\n");

test("captures the fMP4 init segment from #EXT-X-MAP", () => {
  const p = scpParseMediaPlaylist(fmp4, "https://cdn.example/live/v/index.m3u8");
  assert.strictEqual(p.initSegmentUrl, "https://cdn.example/live/v/init.mp4");
  assert.strictEqual(p.segments.length, 2);
  assert.deepStrictEqual(p.segments.map(s => s.seq), [90, 91]);
});

// --- VOD playlist terminates ---
test("detects #EXT-X-ENDLIST on finished streams", () => {
  const vod = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXTINF:6.000,", "a.ts", "#EXT-X-ENDLIST"].join("\n");
  const p = scpParseMediaPlaylist(vod, "https://cdn.example/vod.m3u8");
  assert.strictEqual(p.endList, true);
  assert.strictEqual(p.segments.length, 1);
});

test("survives empty and malformed input", () => {
  assert.deepStrictEqual(scpParseMasterPlaylist("", "https://x/y.m3u8"), []);
  const p = scpParseMediaPlaylist("garbage\nnot a playlist", "https://x/y.m3u8");
  assert.strictEqual(p.segments.length, 2); // treated as URIs; caller validates
  assert.strictEqual(scpIsMasterPlaylist(""), false);
});

console.log(`\n${passed} HLS parser tests passed`);
