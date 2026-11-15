# Repository overview

## `stream-clipper/` — StreamClip Pro (the project)

A Chrome extension (Manifest V3) that turns live streams on Twitch, Kick and
YouTube into upload-ready MP4 files hands-free: it starts buffering when a
live channel plays, saves the stream as back-to-back segments at source
quality with ads left out, and delivers them to your computer and optionally
to Google Drive. It also clips the moments live chat reacts to as separate
highlights and can hand them to a self-hosted OpenShorts or SupoClip to become
captioned 9:16 shorts. Manual "save the last N seconds" clipping works alongside.
See [`stream-clipper/README.md`](stream-clipper/README.md) for install, usage,
architecture and test instructions.

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
