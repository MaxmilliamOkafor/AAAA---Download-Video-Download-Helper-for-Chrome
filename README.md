# StreamClip Pro

The extension lives in
[`AAAA - Download Video Download Helper for Chrome/`](AAAA%20-%20Download%20Video%20Download%20Helper%20for%20Chrome/).

A Chrome extension (Manifest V3) that turns live streams on Twitch, Kick and
YouTube into upload-ready MP4 files hands-free: it starts buffering when a
live channel plays, saves the stream as back-to-back segments at source
quality with ads left out, and delivers them to your computer and optionally
to Google Drive. It also clips the moments live chat reacts to as separate
highlights and can hand them to a self-hosted OpenShorts or SupoClip to become
captioned 9:16 shorts. Manual "save the last N seconds" clipping works alongside.

See that folder's [README](AAAA%20-%20Download%20Video%20Download%20Helper%20for%20Chrome/README.md)
for install, usage, architecture and tests.

## Install

1. Download the repository and extract it to a **short path** such as
   `C:\sc` (see the note below).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → select the `AAAA - Download Video Download Helper for Chrome`
   folder (the one with `manifest.json` directly inside it).

**Windows note:** GitHub names its zip folder after the repository and
branch, and Windows' extract wizard nests that folder twice. Extracting into
your Downloads folder can then exceed Windows' 260-character path limit
("Error 0x80010135: Path too long"). Extracting to `C:\sc` avoids it.

## History

This folder previously held an unpacked copy of Video DownloadHelper
10.5.10.2, a commercial Chrome Web Store extension by the Video Download
Helper Team, uploaded as reference. It was never part of StreamClip, which
was written from scratch, and it has been replaced by StreamClip at the
owner's request. It remains in this repository's git history.
