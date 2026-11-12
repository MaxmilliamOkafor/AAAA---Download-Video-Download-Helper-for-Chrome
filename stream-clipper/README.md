# StreamClip Pro

A Chrome extension (Manifest V3) that turns the live streams you watch into
upload-ready video files without you doing anything.

Open a live channel on Twitch, Kick or YouTube and StreamClip starts buffering
it, saves it as back-to-back MP4 segments, leaves the ads out, and delivers the
files to your computer and, optionally, to your Google Drive. Manual clipping
("save the last 60 seconds") works alongside, for the moments you want on
their own.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this `stream-clipper` folder.
3. The dashboard opens. Nothing needs configuring.

## What happens with no setup

| Step | What StreamClip does | Default |
|---|---|---|
| Capture | Starts by itself a few seconds after a live channel begins playing. Buffers the broadcaster's **original segments** at the **best rendition offered**, regardless of the quality you are watching. | on |
| Clip | Saves each stream as consecutive segments that tile exactly, with no gaps or overlap. When a stream ends, the tab closes or you move to another channel, the unsaved remainder is saved too. | every 15 min |
| Convert | Rewraps MPEG-TS as **MP4** with no re-encoding: the video bitstream is identical to the broadcast. | MP4 |
| Ads | Stitched ad segments are detected from the stream's playlist and never downloaded. | excluded |
| Deliver | `Downloads/StreamClips/<site>/<streamer> - <date> <time> (<length>s).mp4` | this computer |

Automatic clips are silent. The toolbar badge shows how many streams are being
buffered, and the dashboard's **Clip library** lists every file and where it
went.

Automatic start works on live channel pages (`twitch.tv/<channel>`,
`kick.com/<channel>`, YouTube watch and live pages) when the site plays over
HLS. Directories, VODs, clips and hover previews are ignored. On any other
site, or when a stream is not HLS, click the toolbar icon on the stream's tab
(or press **Alt+M**) to record the rendered tab instead; Chrome requires that
click before a tab's pixels can be captured.

## Everything is still yours to change

The dashboard (toolbar icon → **Dashboard**) has five sections. Settings save
as you change them and apply to running captures.

- **Live** — one card per stream: rendition picker, measured resolution, frame
  rate, codec and bitrate, buffer fill, time to the next automatic clip, and
  manual clip buttons (`All`, your presets, and a custom min:sec field).
- **Clip library** — every clip with length, size and delivery status for the
  computer and for Drive; shortcuts to the file and to the Drive copy.
- **Automation** — auto-clip on/off and segment length (any length: `90s`,
  `15m`, `1h 30m`), Google Drive delivery, and the pipeline at a glance.
- **Capture** — automatic start, capture mode, source quality cap, ad
  exclusion, buffer length and memory cap, tab-mode quality.
- **Output** — MP4 or original container, file-name template, quick-clip
  buttons, post-roll, notifications, shortcuts.

Shortcuts: **Alt+C** clips the current tab, **Alt+Shift+C** clips every
stream, **Alt+M** starts or stops monitoring the current tab.

## Google Drive

Two ways to get every clip into Drive:

**Without any setup here:** install Google Drive for desktop and add your
`Downloads/StreamClips` folder to it. Clips sync as they are saved.

**Built-in upload:** turn on *Google Drive delivery* in **Automation**.
Uploads run in the background in resumable 16 MiB chunks into
`StreamClips/<streamer>/`. This needs a one-time, free Google OAuth client of
your own (the dashboard lists the five steps and shows the redirect URI to
paste, `https://mlcghpbkpjmomgpcpeojglkbbhfjmggd.chromiumapp.org/`). No
credentials ship with the extension and nothing passes through a third-party
server. The scope is `drive.file`: StreamClip can see only the files it
created.

If an upload fails and the clip was not also kept locally, it is saved to
Downloads instead. A clip is never dropped.

## Feeding an AI clipping tool

Tools that cut shorts out of long videos generally take a file upload. Taja's
site, for example, says it imports from YouTube or "any file on your
computer", accepts mp4, mov, m4v, avi, mpeg, webm and mkv, and limits uploads
to 5–10 GB and 2–5 hours depending on plan ([home page](https://www.taja.ai/),
[pricing](https://www.taja.ai/pricing), read November 2026). It does not list
Google Drive as an import source. StreamClip's defaults fit that directly:
15-minute MP4 segments in `Downloads/StreamClips`, about 0.9 GB each at
8 Mbps. `.ts` files, which Twitch and Kick deliver natively, are not on that
list, which is why MP4 is the default.

## Capture modes

| | Source | Tab |
|---|---|---|
| Records | The broadcaster's original HLS segments | The pixels the tab renders, cropped to the player |
| Quality | Identical to the broadcast | Re-encoded; limited by what the player shows |
| Starts by itself | Yes | No — needs a click on the tab |
| Output | `.mp4` (or `.ts` if you choose) | `.webm` |
| Cost while buffering | Bandwidth: the stream is downloaded a second time | CPU: a live encode |
| Ads | Skipped from playlist markers, never downloaded | Cut using the player's ad indicator |

Switching rendition on a stream's card restarts that stream's buffer, because
segments at different resolutions cannot be joined into one file.

## Architecture

```
manifest.json            MV3 manifest
background.js            Service worker: session registry, playlist discovery,
                         automatic start, auto-clip scheduler (alarms),
                         delivery routing, clip history
drive-auth.js            Google sign-in for the worker (launchWebAuthFlow)
offscreen/               Long-lived capture document
  offscreen.js             capture engines, clip registry, message routing
  hls-buffer.js            source mode: playlist polling, segment buffer
  ts-to-mp4.js             MPEG-TS -> fragmented MP4 without re-encoding
  drive-upload.js          Drive v3 resumable uploads
  webm-rebase.js           tab mode: rebases WebM timecodes to 0:00
content/video-locator.js Tab mode: finds the player and detects ads
ui/                      Design system and the stream card, shared by both UIs
popup/                   Quick controls
dashboard/               Live, library, automation and all settings
shared/                  Settings model, HLS playlist parser
vendor/mux-mp4.min.js    mux.js 6.3.0 (Apache-2.0), the MP4 container writer
test/                    Unit and end-to-end tests
```

State that must survive the service worker being suspended lives in
`chrome.storage.session` and is reconciled against the offscreen document,
which is the authority on what is recording. A clip's data stays alive until
every delivery that needs it has finished.

The extension requests `<all_urls>` because stream segments are served from
CDN hostnames that cannot be listed ahead of time. Requests are observed, never
blocked or modified.

The `key` in `manifest.json` pins the extension ID, so the Drive redirect URI
stays the same wherever the folder is loaded from. Remove it before submitting
to the Chrome Web Store, which assigns its own.

## Tests

```
npm test            # 31 unit tests: playlist parser, Drive uploader, MP4 remux
npm run test:e2e    # 10 checks in real Chromium with the extension loaded
```

The end-to-end test serves a simulated live channel (with a stitched ad) from a
local server mapped to a `twitch.tv` URL, opens it, and does nothing else. It
asserts that capture starts on its own at the best rendition, the ad segment
is never fetched, automatic clips tile the stream, a channel switch and a tab
close each save the remainder, and the files Chromium writes are valid
1080p H.264 MP4s that play straight through. `npm test` needs Node and, for
the remux test, ffmpeg; the end-to-end test needs Playwright and ffmpeg.

## What has not been verified

- **Live Twitch, Kick and YouTube.** Everything above was exercised against a
  local stream built to the HLS specification and to the stitched-ad markers
  Twitch is known to use, not against the real sites. YouTube live frequently uses DASH
  rather than HLS; those streams will need the click-to-record tab mode.
- **Google Drive.** The uploader is tested against an imitation of Drive's
  resumable protocol (chunking, a dropped connection, a 503, an expired
  token). It has not yet uploaded to a real Drive account.
- **Tab mode in a real tab.** Cropping to the player and the ad indicator
  selectors have unit-level checks only; site markup changes can break the
  selectors.

## Limits worth knowing

- Source mode roughly doubles bandwidth per stream; several streams at once
  add up. Pick a lower rendition on a card, or cap source quality in
  **Capture**, if playback stutters.
- The buffer is held by the browser (as blobs, which Chrome can page to disk).
  With auto-clip on, 30 minutes is plenty; unlimited is available but grows
  about 3.4 GB per hour per stream at 8 Mbps.
- Clip boundaries fall on segment edges (about 2 seconds on Twitch).
- DRM-protected video cannot be captured in either mode.

## Responsible use

StreamClip records streams you are watching. Whether you may republish a clip
depends on the platform's terms and the streamer's permission; many streamers
encourage clipping and some do not. Get permission before posting someone
else's content and honour takedown requests.
