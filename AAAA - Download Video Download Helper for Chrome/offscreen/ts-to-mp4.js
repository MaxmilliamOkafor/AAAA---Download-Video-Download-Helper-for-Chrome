// Remuxes MPEG-TS segments into one fragmented MP4, without re-encoding.
//
// Source-mode clips are the broadcaster's original HLS segments. On Twitch and
// Kick those are MPEG-TS, which editors read but most upload tools and AI
// clipping services reject. Remuxing only rewraps the same H.264/AAC samples
// in an MP4 container: no decode, no encode, no quality change.
//
// The container work is done by mux.js (Apache-2.0, vendored in /vendor).
// This module feeds it one segment at a time so a multi-gigabyte clip never
// has to exist as a single array in memory, and it re-anchors the timeline
// wherever segments are missing (an ad break that was skipped, for instance)
// so the output plays straight through instead of stalling over a gap.

const SCP_MP4_TIMESCALE = 90000; // MPEG-TS clock, which mux.js keeps for MP4

// segments: [{ blob | bytes, duration (s), seq }] in playback order.
// Returns { parts: BlobPart[], durationSeconds } or throws; the caller keeps
// the original .ts if this fails.
async function scpRemuxTsToMp4(segments, muxLib) {
  const mux = muxLib || (typeof muxjs !== "undefined" ? muxjs : null);
  // The MP4-only bundle exposes Transmuxer at the top level; the full bundle
  // nests it under .mp4. Accept either.
  const Transmuxer = mux && ((mux.mp4 && mux.mp4.Transmuxer) || mux.Transmuxer);
  if (!Transmuxer) throw new Error("MP4 remuxer unavailable");
  if (!segments || segments.length === 0) throw new Error("nothing to remux");

  const parts = [];
  let initWritten = false;
  let outputTicks = 0;      // timeline position where the next segment starts
  let previousSeq = null;
  let transmuxer = null;
  let failure = null;

  const attach = () => {
    transmuxer = new Transmuxer({ keepOriginalTimestamps: false });
    transmuxer.setBaseMediaDecodeTime(outputTicks);
    transmuxer.on("data", event => {
      // Every flush repeats the init segment; a file needs it exactly once.
      if (!initWritten && event.initSegment && event.initSegment.byteLength) {
        parts.push(event.initSegment);
        initWritten = true;
      }
      if (event.data && event.data.byteLength) parts.push(event.data);
    });
    transmuxer.on("error", err => {
      failure = failure || new Error((err && err.message) || "remux error");
    });
  };

  for (const segment of segments) {
    const contiguous =
      previousSeq === null || segment.seq == null || segment.seq === previousSeq + 1;
    // A gap in sequence numbers means footage was left out. Start a fresh
    // transmuxer anchored at the current output position, so timestamps stay
    // continuous across the cut.
    if (!transmuxer || !contiguous) attach();

    const bytes = segment.bytes
      ? segment.bytes
      : new Uint8Array(await segment.blob.arrayBuffer());
    transmuxer.push(bytes);
    transmuxer.flush();
    if (failure) throw failure;

    outputTicks += Math.round((segment.duration || 0) * SCP_MP4_TIMESCALE);
    previousSeq = segment.seq == null ? previousSeq : segment.seq;
  }

  if (!initWritten || parts.length < 2) throw new Error("remux produced no media");
  return { parts, durationSeconds: outputTicks / SCP_MP4_TIMESCALE };
}

if (typeof globalThis !== "undefined") globalThis.scpRemuxTsToMp4 = scpRemuxTsToMp4;
if (typeof module !== "undefined" && module.exports) module.exports = { scpRemuxTsToMp4 };
