# StreamClip Pro — Live Stream Replay Clipper

A professional Chrome extension (Manifest V3) for content creators who clip live
streams. It works like OBS's instant-replay buffer, but inside your browser:
while you watch a stream, StreamClip keeps a rolling buffer of the most recent
footage — when something great happens, one click (or **Alt+C**) saves the last
N seconds as a video file. Nothing is ever saved unless *you* ask.

Works on **Twitch**, **Kick**, **YouTube live** and any other site that plays
video in a tab.

## Why this design

- **Never miss a moment.** The moment already happened when you react to it —
  a replay buffer is the only way to clip *backwards* in time. You choose how
  far back (5 seconds to 30 minutes).
- **No spam, no duplicates.** There is no auto-detected media list and no
  auto-clipping. Each monitored stream is exactly **one card** in the popup —
  no three duplicate "Live on Twitch.mp4" entries for the same stream, and no
  random clips appearing on their own. A clip exists only when you press a
  button or a hotkey.
- **Multi-streamer.** Monitor several tabs at once (Twitch + Kick + YouTube
  simultaneously). Clip one stream, or hit **Alt+Shift+C** / "⚡ Clip all" to
  clip every monitored stream at the same moment.
- **True source quality, no re-encoding.** When a stream uses HLS (Twitch and
  Kick always do, most YouTube live does), StreamClip buffers the
  broadcaster's **original video segments** — the exact bytes the CDN sends —
  and a clip is those segments concatenated. No decode/encode round trip, so
  there is zero generation loss: the clip is the broadcast. It also always
  buffers the stream's *best* rendition, so you can watch at 720p to save
  bandwidth and still clip at 1080p60. Falls back automatically to tab
  recording on sites that don't expose HLS.
- **Full quality control.** In tab mode: resolution cap up to 4K, 30/60 fps,
  video bitrate up to 30 Mbps, audio up to 320 kbps, codec preference
  (H.264 / VP9 / VP8).
- **Editor-ready files.** Clip timestamps are rebased to start at 0:00
  (in-place WebM timecode patching, covered by unit tests), so clips show the
  correct duration and scrub cleanly in players and editors.
- **Post-roll.** Optionally keep recording 5–60 extra seconds after you hit
  clip, so the reaction/aftermath makes it into the same file.

## Install (developer mode)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `stream-clipper` folder.
4. Pin the extension. Open a live stream, click the icon, press
   **Start monitoring**.

## Usage

| Action | How |
|---|---|
| Start buffering a stream | Open the popup on a stream page (auto-starts by default), or **Start monitoring**, or **Alt+M** |
| Save the last 30s / 1m / 2m / 5m | Click a quick-clip button on the stream's card |
| Save a custom length | Enter min : sec on the card → **Clip** |
| Clip the current tab instantly | **Alt+C** (uses your default clip length) |
| Clip every monitored stream at once | **Alt+Shift+C** or **⚡ Clip all** |
| Include the aftermath | Set a post-roll in Settings — clips save after +N extra seconds |
| Find a saved clip | Popup → **Clip history** → 📂 Show file (or click the save notification) |
| Stop monitoring | ✕ on the stream's card or **Alt+M** (buffer is discarded) |

Clips land in your Downloads folder, organized by the filename template
(default: `StreamClips/{site}/{streamer} - {date} {time} ({length}s).webm`).
Everything is configurable in **Settings**: buffer length, memory cap,
quick-clip presets, hotkey clip length, quality, filename template, and
notifications.

## Architecture

```
manifest.json          MV3 manifest (tabCapture, offscreen, downloads, webRequest)
background.js          Service worker: session registry, HLS playlist discovery,
                       capture-mode selection, downloads, hotkeys, notifications
offscreen/
  hls-buffer.js        Source mode: polls the media playlist, keeps original
                       segments in a rolling buffer, concatenates clips
  offscreen.js         Tab mode: one MediaRecorder per tab, chunk buffer,
                       clip assembly; routes both modes' messages
  webm-rebase.js       Rebases WebM cluster timecodes to 0:00 (unit-tested)
popup/                 Control center: one card per monitored stream + history
options/               Full settings page (chrome.storage.sync)
shared/
  settings.js          Settings model, filename templating, site detection
  hls-parse.js         HLS master/media playlist parser (unit-tested)
test/                  Node unit tests — run: node test/hls-parse.test.js
```

Source mode discovers the playlist by observing (never blocking or modifying)
`.m3u8` requests the tab already makes, then fetches the media playlist and its
segments directly. This is why the extension requests `webRequest` and broad
host permissions: stream segments are served from arbitrary CDN hostnames that
can't be enumerated ahead of time.

Capture uses `chrome.tabCapture` → `MediaRecorder` in an offscreen document
with 1-second timeslices. The first chunk (container header) is retained and
prepended to the selected window of recent chunks to produce a playable WebM.
Tab audio is routed back to your speakers during capture, so the stream stays
audible.

### Capture modes

| | Source mode | Tab mode |
|---|---|---|
| What it records | The broadcaster's original HLS segments | The pixels the tab renders |
| Quality | Identical to the broadcast — no re-encode | Re-encoded; capped by what the player shows |
| Clip quality vs. watch quality | Independent — watch 720p, clip 1080p60 | Same as what you're watching |
| Output | `.ts` (Twitch/Kick) or `.mp4` (fMP4 streams) | `.webm` |
| CPU cost while buffering | Low (just downloading) | Higher (live encoding) |
| Works on | HLS sites: Twitch, Kick, most YouTube live | Any site with video |
| Clip precision | Segment-aligned (~2s on Twitch) | ~1 second |

Auto mode (the default) uses source when it's available and silently falls
back to tab when it isn't. Choose **Source only** if you'd rather be told the
quality isn't available than get a re-encoded clip.

### Ads never reach your clips

Mid-roll ads are detected and excluded automatically, by different means in
each mode:

- **Source mode** reads the ad markers in the stream's own playlist —
  `EXT-X-DATERANGE` with an ad class (how Twitch stitches mid-rolls) and
  `CUE-OUT`/`CUE-IN` brackets. Those segments are never downloaded at all, so
  ads cost you no bandwidth and cannot reach the buffer. Parsing is covered by
  unit tests, including breaks that end early and non-ad date ranges that must
  not be mistaken for ads.
- **Tab mode** watches the ad indicator each site renders (Twitch's ad label
  and countdown, YouTube's `ad-showing` state, Kick's overlay) and drops the
  footage recorded during the break.

Either way the clip cuts straight from pre-ad content to where the stream
resumed. The stream card shows `⏸ Ad break — excluded from clips` live, and
afterwards how much advertising was kept out; the clip history records how much
was removed from each saved file. Turn it off in Settings if you ever want the
raw recording.

### Seeing quality before you save

Each stream card shows exactly what a clip will contain, live:

```
⬥ SOURCE   1920×1080 · 60 fps · H.264 · 8.2 Mbps  (no re-encode)
Buffer: 4m 12s / 30m · 248 MB · since 21:04
```

Resolution, frame rate and codec come from the stream's own rendition in
source mode, and from the actual recorded canvas in tab mode — so what you see
is what gets written, not the configured target. Bitrate in tab mode is
measured from the live buffer rather than assumed.

Every quick-clip button also carries its own estimated file size at the current
bitrate, so a 30m clip tells you it's ~1.7 GB before you click it.

### Saving everything recorded

Every stream card has a permanent **All** button that saves the entire buffer —
everything recorded since monitoring started. It needs no configuration, can
never ask for more than exists, and shows the exact length and size it will
produce (`All · 47m · ~2.8 GB`). It is the one button that always gives you the
maximum footage available.

### Long clips (30 minutes, 1 hour and beyond)

Quick-clip presets accept `s` / `m` / `h`, so `30s, 1m, 5m, 30m, 1h` is a valid
preset list, and the buffer goes up to **4 hours**.

The one rule: **you can only clip what the buffer holds.** A 1-hour clip needs a
1-hour buffer, and that buffer lives in RAM — roughly 3.4 GB at 8 Mbps. Two
things make this visible instead of surprising:

- The options page estimates memory for your chosen buffer length and bitrate,
  and warns when your memory cap would truncate it. A 30-minute buffer at the
  default 600 MB cap really only holds about 10 minutes — raise both together.
- A preset longer than the buffer is drawn dashed and dimmed, and its tooltip
  says what you'd actually get. It stays clickable and saves everything
  available; it never fails silently.
- **Quick setup** buttons in Settings move buffer length, memory cap and clip
  buttons together in one click, so the combination is always coherent:
  *Light* (10 min / 600 MB), *Long clips* (1 hour / 4 GB) and *Marathon*
  (2 hours / 8 GB). Save, then restart monitoring for the new buffer to apply.

For hour-long buffers, source mode is much lighter than tab mode: it stores the
broadcast's own compressed segments rather than a live re-encode.

### Clips contain the video only

Neither mode puts chat, the sidebar or page chrome in your clips:

- **Source mode** never could — HLS segments are the broadcast video itself,
  with no page around it. This is another reason to prefer it.
- **Tab mode** now locates the player in the page and crops the capture to it,
  following theater mode, fullscreen and window resizes, and trimming
  letterbox/pillarbox bars so the clip is exactly the picture. On a typical
  Twitch layout that removes about half the frame — and because the crop keeps
  the captured pixels rather than scaling them down, the entire bitrate is
  spent on video instead of static page furniture. Turn it off in Settings if
  you ever want the whole page.

### Monitoring several streamers at once

Monitor as many tabs as you like — Twitch, Kick and YouTube side by side. Each
tab is an independent buffer with its own card, and **⚡ Clip all** /
**Alt+Shift+C** clips every one of them at the same instant.

All captures share a single offscreen document, which is what made earlier
versions fragile here. Fixed in 1.3.0: starting a second stream could collide
with creating that shared document and report the tab as already monitored,
concurrent starts on one tab (auto-start plus a click) raced into the same
error, and teardown paths could close the shared document while other tabs
were still recording. Starts are now idempotent and de-duplicated per tab, and
the document is only closed once it confirms nothing is left recording.

Practical limits are bandwidth and CPU, not the extension: in source mode each
stream adds its own download, and in tab mode each adds a live encode. Four or
five 1080p streams is comfortable on a decent machine; beyond that, lower the
source quality cap or drop tab mode to 30 fps.

### Troubleshooting

**The stream stutters while monitoring.** Source mode downloads the stream a
second time, in parallel with the player, so it roughly doubles your bandwidth
use — and buffering a rendition higher than the one you're watching costs more
still. On a tight connection, lower the **source quality cap** (720p is
lightest) or switch to **tab mode**, which adds no network traffic at all.
In tab mode the cost is CPU instead: live 1080p60 encoding is demanding, so
drop to 30 fps or 720p if the player starts dropping frames.

**The popup says no streams are monitored, but recording is running.** This was
a bug in versions before 1.2.1 and is fixed. Chrome suspends extension service
workers after about 30 seconds idle; the session registry lived only in memory,
so it vanished on suspend while the offscreen document kept recording. State
now persists in `chrome.storage.session` and is reconciled against the
offscreen document — the authority on what is actually live — whenever the
worker restarts.

**Source mode never engages (badge always shows TAB).** The playlist is
discovered by observing the `.m3u8` requests the page makes, so playback has to
start before monitoring. Let the stream play a few seconds, then start
monitoring. Sites that don't use HLS will always fall back to tab mode.

### Known limitations

- Source clips are `.ts` (MPEG-TS) on Twitch/Kick. Premiere, DaVinci, CapCut,
  VLC and OBS all import `.ts` directly; if a tool refuses it, remux losslessly
  with `ffmpeg -c copy`. fMP4 streams save as `.mp4` with their init segment
  prepended.
- Source clips start on a segment boundary, so a requested 30s may arrive as
  30–32s on Twitch. Tab mode is accurate to ~1 second.
- Tab-mode clips are WebM (H.264/VP9 + Opus) with timestamps rebased to 0:00.
- DRM-protected video (Widevine) captures as a black frame in tab mode — that's a browser
  guarantee, not a bug. Standard Twitch/Kick/YouTube live streams are fine.
- Capture records what the tab renders. For pristine quality: set the player
  to source quality, keep the tab undocked or in the background (audio and
  video keep recording), and avoid resizing the window mid-capture.

## Responsible use

This tool records the streams you watch, for your own clipping workflow.
Whether you may republish a clip depends on the platform's terms and the
streamer's permission — many streamers explicitly encourage clipping, some
don't. Get permission before posting someone else's content, and always
respect DMCA takedowns. You are responsible for how you use recorded footage.
