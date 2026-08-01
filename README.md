# Repository overview

## `stream-clipper/` — StreamClip Pro (the project)

An original, production-ready Chrome extension (Manifest V3) for clipping live
streams: a rolling replay buffer for Twitch, Kick, YouTube live and any other
video tab, with one-click / hotkey "save the last N seconds" clipping,
multi-stream monitoring, and full quality + settings control.
See [`stream-clipper/README.md`](stream-clipper/README.md) for install and
usage instructions.

## `AAAA - Download Video Download Helper for Chrome/` — third-party code, do not ship

This folder is an extracted copy of **Video DownloadHelper**, a proprietary
extension from the Chrome Web Store (note its `_metadata/verified_contents.json`
store-signing file). It is **not** part of this project and must not be
modified, rebranded, redistributed, or deployed — doing so would infringe the
original author's copyright. It is kept here only as the original uploaded
reference material; the recommendation is to remove it from the repository.
