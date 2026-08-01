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
- **Full quality control.** Resolution cap up to 4K, 30/60 fps, video bitrate
  up to 30 Mbps, audio up to 320 kbps, codec preference (H.264 / VP9 / VP8).
  Capture quality matches what the player renders — set the stream to its
  highest quality (1080p60, 4K) for best results.

## Install (developer mode)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `stream-clipper` folder.
4. Pin the extension. Open a live stream, click the icon, press
   **Start monitoring**.

## Usage

| Action | How |
|---|---|
| Start buffering a stream | Popup → **Start monitoring** on the current tab |
| Save the last 30s / 1m / 2m / 5m | Click a quick-clip button on the stream's card |
| Save a custom length | Enter min : sec on the card → **Clip** |
| Clip the current tab instantly | **Alt+C** (uses your default clip length) |
| Clip every monitored stream at once | **Alt+Shift+C** or **⚡ Clip all** |
| Stop monitoring | ✕ on the stream's card (buffer is discarded) |

Clips land in your Downloads folder, organized by the filename template
(default: `StreamClips/{site}/{streamer} - {date} {time} ({length}s).webm`).
Everything is configurable in **Settings**: buffer length, memory cap,
quick-clip presets, hotkey clip length, quality, filename template, and
notifications.

## Architecture

```
manifest.json          MV3 manifest (tabCapture, offscreen, downloads, storage)
background.js          Service worker: session registry, downloads, hotkeys, notifications
offscreen/             Capture engine: one MediaRecorder per tab, rolling chunk
                       buffer with time + memory pruning, clip assembly
popup/                 Control center: one card per monitored stream
options/               Full settings page (chrome.storage.sync)
shared/settings.js     Settings model, filename templating, site/streamer detection
```

Capture uses `chrome.tabCapture` → `MediaRecorder` in an offscreen document
with 1-second timeslices. The first chunk (container header) is retained and
prepended to the selected window of recent chunks to produce a playable WebM.
Tab audio is routed back to your speakers during capture, so the stream stays
audible.

### Known limitations (v1)

- Clips are WebM (H.264/VP9 + Opus). Every major editor (Premiere, DaVinci,
  CapCut) imports WebM; choose H.264 in settings for the widest compatibility.
- Clip boundaries are accurate to ~1 second (chunk granularity).
- The duration shown by some players for a clip may be off until the file is
  re-exported by an editor, because the buffer's timestamps don't start at
  zero. The footage itself is complete.
- DRM-protected video (Widevine) captures as a black frame — that's a browser
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
