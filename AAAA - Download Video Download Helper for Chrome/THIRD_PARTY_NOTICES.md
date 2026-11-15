# Third-party notices

## Included in this extension

### mux.js 6.3.0 — Apache License 2.0

`vendor/mux-mp4.min.js` is the unmodified MP4 build of
[mux.js](https://github.com/videojs/mux.js) by Brightcove, Inc. Its licence is
in `vendor/mux.js-LICENSE.txt`. StreamClip uses it to rewrap MPEG-TS stream
segments as MP4 without re-encoding.

## Not included — integrated over the network, or credited for an idea

### OpenShorts — MIT License

[github.com/mutonby/openshorts](https://github.com/mutonby/openshorts),
Copyright (c) 2024 OpenShorts.

- **Idea credited:** finding stream highlights from what viewers react to,
  rather than from a transcript (its `twitch_signals.py` uses the clips
  viewers cut from a finished Twitch VOD). StreamClip applies the same idea to
  live chat in `shared/hype.js`. That code is StreamClip's own; no OpenShorts
  code is copied.
- **Integration:** StreamClip can send clips to a self-hosted OpenShorts
  through its public HTTP API (`POST /api/process`). OpenShorts is a separate
  program the user runs; it is not distributed with StreamClip.

### SupoClip — GNU Affero General Public License v3.0

[github.com/FujiwaraChoki/supoclip](https://github.com/FujiwaraChoki/supoclip).

- **Integration only:** StreamClip can send clips to a self-hosted SupoClip
  through its documented HTTP API (`POST /upload`, `POST /tasks/`). No
  SupoClip code is included in or derived into StreamClip, so its AGPL terms
  apply to SupoClip itself, not to this extension. SupoClip is a separate
  program the user runs.
