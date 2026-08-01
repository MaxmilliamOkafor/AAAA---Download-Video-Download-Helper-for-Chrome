# Repository overview

## `stream-clipper/` — StreamClip Pro (the project)

A production-ready Chrome extension (Manifest V3) for clipping live streams on
Twitch, Kick and YouTube: a rolling replay buffer so you can save moments
*after* they happen, source-quality capture with no re-encoding, multi-stream
monitoring, hotkeys, and full settings control.
See [`stream-clipper/README.md`](stream-clipper/README.md) for install, usage
and architecture.

## `AAAA - Download Video Download Helper for Chrome/` — reference only, do not ship

This folder is an unpacked copy of **Video DownloadHelper 10.5.10.2**, a
commercial extension published on the Chrome Web Store by the Video Download
Helper Team (downloadhelper.net). It is not a starting point for this project
and must not be modified, rebranded, or redistributed:

- **It is a third-party product.** Its `manifest.json` carries the publisher's
  extension `key` and an `update_url` pointing at the Web Store, and
  `_metadata/verified_contents.json` holds Google's signature over the file
  contents. Shipping a modified copy would infringe the publisher's copyright,
  and the retained key/update URL would collide with the genuine listing.
- **It has no source.** Every script is a minified production bundle
  (4,900–9,000 bytes per line). There is no build system, no tests, and no
  readable code to extend.
- **It solves a different problem.** It downloads media that already exists.
  It has no replay buffer, so it cannot capture a moment you have already
  watched go by — the core requirement of a clipping tool.

StreamClip Pro was written from scratch. Where the two overlap conceptually —
reading a stream's HLS playlist to obtain original-quality segments instead of
re-encoding rendered video — StreamClip implements that standard technique
independently, against the public [HLS specification (RFC 8216)][rfc8216], with
its own unit-tested parser in `stream-clipper/shared/hls-parse.js`.

The recommendation is to delete this folder from the repository.

[rfc8216]: https://www.rfc-editor.org/rfc/rfc8216
