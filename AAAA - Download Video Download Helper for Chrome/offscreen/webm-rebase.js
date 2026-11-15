// Rebases cluster timecodes of a clipped (mid-stream) WebM so playback starts
// at t=0. Without this, players show the clip starting minutes/hours in,
// with wrong duration and broken scrubbing.
//
// The fix is safe by construction: timecodes are patched *in place* with
// same-length integers (new values are always smaller than the originals),
// so byte offsets never shift. Any parse anomaly aborts and the caller keeps
// the original bytes.

const EBML_ID_EBML_HEADER = 0x1a45dfa3;
const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_CLUSTER = 0x1f43b675;
const EBML_ID_TIMECODE = 0xe7;
// Segment-level siblings that can terminate an unknown-size cluster.
const EBML_SEGMENT_LEVEL_IDS = new Set([
  EBML_ID_CLUSTER,
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0x1254c367, // Tags
  0x1c53bb6b, // Cues
  0x114d9b74, // SeekHead
  0x1941a469  // Attachments
]);

function scpReadElementHeader(bytes, pos) {
  // Element ID: 1-4 bytes, marker bit kept.
  const id = readVint(bytes, pos, true, 4);
  if (!id) return null;
  const size = readVint(bytes, pos + id.length, false, 8);
  if (!size) return null;
  return {
    id: id.value,
    size: size.value,
    unknownSize: size.unknown,
    contentStart: pos + id.length + size.length
  };

  function readVint(buf, p, keepMarker, maxLen) {
    if (p >= buf.length) return null;
    const first = buf[p];
    let mask = 0x80;
    let len = 1;
    while (len <= maxLen && !(first & mask)) {
      mask >>= 1;
      len++;
    }
    if (len > maxLen || p + len > buf.length) return null;
    let value = keepMarker ? first : first & (mask - 1);
    let allOnes = !keepMarker && (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      value = value * 256 + buf[p + i];
      if (buf[p + i] !== 0xff) allOnes = false;
    }
    return { value, length: len, unknown: allOnes };
  }
}

// Collects { pos, length, value } for the Timecode element of each cluster.
function scpCollectClusterTimecodes(bytes) {
  const found = [];
  let pos = 0;
  while (pos < bytes.length) {
    const el = scpReadElementHeader(bytes, pos);
    if (!el) break;
    if (el.id === EBML_ID_SEGMENT) {
      const end = el.unknownSize ? bytes.length : el.contentStart + el.size;
      scanSegment(el.contentStart, Math.min(end, bytes.length));
      pos = end;
    } else if (el.id === EBML_ID_EBML_HEADER && !el.unknownSize) {
      pos = el.contentStart + el.size;
    } else {
      if (el.unknownSize) throw new Error("unexpected unknown-size element at top level");
      pos = el.contentStart + el.size;
    }
  }
  return found;

  function scanSegment(start, end) {
    let p = start;
    while (p < end) {
      const el = scpReadElementHeader(bytes, p);
      if (!el) break;
      if (el.id === EBML_ID_CLUSTER) {
        p = scanCluster(el, end);
      } else {
        if (el.unknownSize) throw new Error("unknown-size non-cluster in segment");
        p = el.contentStart + el.size;
      }
    }
  }

  // Returns the position just past the cluster.
  function scanCluster(cluster, segmentEnd) {
    const contentEnd = cluster.unknownSize
      ? segmentEnd
      : Math.min(cluster.contentStart + cluster.size, segmentEnd);
    let p = cluster.contentStart;
    let gotTimecode = false;
    while (p < contentEnd) {
      const child = scpReadElementHeader(bytes, p);
      if (!child) break;
      // An unknown-size cluster ends where the next segment-level element begins.
      if (cluster.unknownSize && EBML_SEGMENT_LEVEL_IDS.has(child.id)) return p;
      if (child.unknownSize) throw new Error("unknown-size element inside cluster");
      if (!gotTimecode && child.id === EBML_ID_TIMECODE) {
        if (child.size < 1 || child.size > 8) throw new Error("bad timecode size");
        let value = 0;
        for (let i = 0; i < child.size; i++) value = value * 256 + bytes[child.contentStart + i];
        found.push({ pos: child.contentStart, length: child.size, value });
        gotTimecode = true;
      }
      p = child.contentStart + child.size;
    }
    return contentEnd;
  }
}

// Mutates `bytes` so the first cluster starts at timecode 0.
// Returns true if anything was patched.
function scpRebaseWebmBytes(bytes) {
  const timecodes = scpCollectClusterTimecodes(bytes);
  if (timecodes.length === 0) return false;
  const offset = timecodes[0].value;
  if (offset === 0) return true;
  for (const tc of timecodes) {
    let v = Math.max(0, tc.value - offset);
    for (let i = tc.length - 1; i >= 0; i--) {
      bytes[tc.pos + i] = v % 256;
      v = Math.floor(v / 256);
    }
    if (v > 0) throw new Error("rebased timecode does not fit"); // cannot happen: new < old
  }
  return true;
}

// Public: returns a rebased copy of the blob, or the original on any failure.
async function scpRebaseWebmBlob(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    scpRebaseWebmBytes(bytes);
    return new Blob([bytes], { type: blob.type });
  } catch (e) {
    console.warn("StreamClip: timestamp rebase skipped:", e.message);
    return blob;
  }
}

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, { scpRebaseWebmBytes, scpRebaseWebmBlob, scpCollectClusterTimecodes });
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { scpRebaseWebmBytes, scpCollectClusterTimecodes };
}
