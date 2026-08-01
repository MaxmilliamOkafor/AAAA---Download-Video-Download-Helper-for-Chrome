// HLS playlist parsing. Pure functions, no browser APIs, so they can be
// unit-tested directly in Node (see test/hls-parse.test.js).

// Parses a master playlist and returns variants sorted best-first.
// A master playlist lists quality renditions via #EXT-X-STREAM-INF.
function scpParseMasterPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = scpParseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    // The URI is the next non-comment, non-empty line.
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;
    const resolution = attrs.RESOLUTION || "";
    const [w, h] = resolution.split("x").map(n => parseInt(n, 10) || 0);
    variants.push({
      url: scpResolveUrl(uri, baseUrl),
      bandwidth: parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10) || 0,
      width: w || 0,
      height: h || 0,
      frameRate: parseFloat(attrs["FRAME-RATE"] || "0") || 0,
      codecs: attrs.CODECS || "",
      name: attrs.VIDEO || attrs.NAME || ""
    });
  }
  // Best first: resolution, then frame rate, then bitrate.
  variants.sort((a, b) =>
    (b.height - a.height) ||
    (b.frameRate - a.frameRate) ||
    (b.bandwidth - a.bandwidth)
  );
  return variants;
}

// Parses a media playlist: the actual segment list for one rendition.
function scpParseMediaPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  const segments = [];
  let mediaSequence = 0;
  let targetDuration = 0;
  let initSegmentUrl = null; // #EXT-X-MAP, used by fMP4 streams
  let pendingDuration = 0;
  let seq = 0;
  let sawSequence = false;
  let endList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10) || 0;
      seq = mediaSequence;
      sawSequence = true;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = parseFloat(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = scpParseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) initSegmentUrl = scpResolveUrl(attrs.URI, baseUrl);
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice("#EXTINF:".length).split(",")[0]) || 0;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      endList = true;
      continue;
    }
    if (line.startsWith("#")) continue; // any other tag

    if (!sawSequence && segments.length === 0) seq = mediaSequence;
    segments.push({
      seq: seq++,
      url: scpResolveUrl(line, baseUrl),
      duration: pendingDuration
    });
    pendingDuration = 0;
  }

  return { segments, mediaSequence, targetDuration, initSegmentUrl, endList };
}

function scpIsMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF:/m.test(String(text));
}

// Parses HLS attribute lists: KEY=VALUE,KEY="quoted,value"
function scpParseAttributes(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1].toUpperCase()] = value;
  }
  return out;
}

function scpResolveUrl(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

// Picks the best variant, optionally capped to a max height so users can
// bound file size (e.g. clip at 1080p even when the source is 4K).
function scpPickVariant(variants, maxHeight) {
  if (!variants || variants.length === 0) return null;
  if (!maxHeight) return variants[0];
  const withinCap = variants.filter(v => !v.height || v.height <= maxHeight);
  return withinCap[0] || variants[variants.length - 1];
}

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    scpParseMasterPlaylist,
    scpParseMediaPlaylist,
    scpIsMasterPlaylist,
    scpParseAttributes,
    scpResolveUrl,
    scpPickVariant
  });
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    scpParseMasterPlaylist,
    scpParseMediaPlaylist,
    scpIsMasterPlaylist,
    scpParseAttributes,
    scpResolveUrl,
    scpPickVariant
  };
}
