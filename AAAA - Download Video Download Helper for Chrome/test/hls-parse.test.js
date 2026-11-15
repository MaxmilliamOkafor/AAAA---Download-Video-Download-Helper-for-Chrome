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

// --- ad breaks: Twitch stitched mid-roll via EXT-X-DATERANGE ---
const twitchAd = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:500",
  "#EXTINF:2.000,",
  "content0.ts",
  '#EXT-X-DATERANGE:ID="stitched-ad-9",CLASS="twitch-stitched-ad",START-DATE="2024-01-01T00:00:00.000Z",DURATION=6.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"',
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:2.000,",
  "ad0.ts",
  "#EXTINF:2.000,",
  "ad1.ts",
  "#EXTINF:2.000,",
  "ad2.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:2.000,",
  "content1.ts"
].join("\n");

test("flags Twitch stitched-ad segments and only those", () => {
  const p = scpParseMediaPlaylist(twitchAd, "https://cdn.example/live.m3u8");
  assert.strictEqual(p.segments.length, 5);
  assert.deepStrictEqual(
    p.segments.map(s => s.isAd),
    [false, true, true, true, false]
  );
  assert.strictEqual(p.adSegmentCount, 3);
  assert.strictEqual(p.inAdBreak, false); // break consumed by segment durations
  // Sequence numbering must stay contiguous across the break.
  assert.deepStrictEqual(p.segments.map(s => s.seq), [500, 501, 502, 503, 504]);
});

test("keeps content URLs intact when ads are present", () => {
  const p = scpParseMediaPlaylist(twitchAd, "https://cdn.example/live.m3u8");
  const content = p.segments.filter(s => !s.isAd).map(s => s.url);
  assert.deepStrictEqual(content, [
    "https://cdn.example/content0.ts",
    "https://cdn.example/content1.ts"
  ]);
});

test("handles CUE-OUT/CUE-IN ad brackets", () => {
  const cued = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:10",
    "#EXTINF:4.000,",
    "a.ts",
    "#EXT-X-CUE-OUT:8.000",
    "#EXTINF:4.000,",
    "ad-a.ts",
    "#EXTINF:4.000,",
    "ad-b.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:4.000,",
    "b.ts"
  ].join("\n");
  const p = scpParseMediaPlaylist(cued, "https://cdn.example/l.m3u8");
  assert.deepStrictEqual(p.segments.map(s => s.isAd), [false, true, true, false]);
  assert.strictEqual(p.adSegmentCount, 2);
});

test("CUE-IN ends a break early even if DATERANGE claimed longer", () => {
  const early = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:2",
    '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",DURATION=60.000',
    "#EXTINF:2.000,",
    "ad.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:2.000,",
    "back.ts"
  ].join("\n");
  const p = scpParseMediaPlaylist(early, "https://cdn.example/l.m3u8");
  assert.deepStrictEqual(p.segments.map(s => s.isAd), [true, false]);
});

test("reports an ad break still open at the live edge", () => {
  const open = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-CUE-OUT:30.000",
    "#EXTINF:2.000,",
    "ad.ts"
  ].join("\n");
  const p = scpParseMediaPlaylist(open, "https://cdn.example/l.m3u8");
  assert.strictEqual(p.inAdBreak, true);
  assert.strictEqual(p.segments[0].isAd, true);
});

test("non-ad DATERANGE tags do not mark segments", () => {
  const chapter = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:2",
    '#EXT-X-DATERANGE:ID="chapter-1",CLASS="chapter",DURATION=600.000',
    "#EXTINF:2.000,",
    "c.ts"
  ].join("\n");
  const p = scpParseMediaPlaylist(chapter, "https://cdn.example/l.m3u8");
  assert.strictEqual(p.segments[0].isAd, false);
  assert.strictEqual(p.adSegmentCount, 0);
});

test("ad-free playlists report no ads", () => {
  const p = scpParseMediaPlaylist(liveTs, "https://cdn.example/live/index.m3u8");
  assert.strictEqual(p.adSegmentCount, 0);
  assert.strictEqual(p.inAdBreak, false);
  assert.ok(p.segments.every(s => s.isAd === false));
});

console.log(`\n${passed} HLS parser tests passed`);
