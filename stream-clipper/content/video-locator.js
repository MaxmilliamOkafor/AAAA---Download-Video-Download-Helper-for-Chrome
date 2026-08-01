// Injected into stream tabs to report where the video player sits, so tab
// capture can be cropped to the video alone — no chat, sidebar or page chrome.
//
// Reports CSS-pixel geometry plus the viewport size; the offscreen document
// converts that into captured-frame pixels. Re-reports on layout changes
// (theater mode, fullscreen, resize) so the crop follows the player.

(() => {
  if (window.__scpVideoLocatorInstalled) {
    // Already running: just re-broadcast current geometry for the new caller.
    if (window.__scpReportVideoRect) window.__scpReportVideoRect();
    return;
  }
  window.__scpVideoLocatorInstalled = true;

  // The stream player is the largest playing video on the page. Picking by
  // area avoids ad overlays, previews and picture-in-picture thumbnails.
  function findPlayerVideo() {
    const videos = [...document.querySelectorAll("video")];
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 10000) continue; // too small to be the player
      if (!v.videoWidth || !v.videoHeight) continue; // no decoded frames yet
      const playing = !v.paused || v.currentTime > 0;
      const score = area * (playing ? 2 : 1);
      if (score > bestArea) {
        bestArea = score;
        best = v;
      }
    }
    return best;
  }

  // Detects an ad playing in the player. Source mode reads ad markers straight
  // from the stream playlist; tab mode has only the page, so it watches the
  // indicators each site renders during a break.
  const AD_SELECTORS = [
    // Twitch
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    '[data-a-target="video-ad-countdown-container"]',
    ".video-player__ad-overlay",
    ".player-ad-notice",
    // YouTube
    ".html5-video-player.ad-showing",
    ".html5-video-player.ad-interrupting",
    ".ytp-ad-player-overlay",
    ".ytp-ad-text",
    // Kick
    '[data-testid="video-ad-overlay"]',
    ".vjs-ad-playing"
  ];

  function isAdPlaying() {
    for (const sel of AD_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      // Guard against hidden placeholder nodes the players keep in the DOM.
      const r = el.getBoundingClientRect();
      const styles = getComputedStyle(el);
      if (styles.display === "none" || styles.visibility === "hidden") continue;
      if (sel.includes("ad-showing") || sel.includes("ad-interrupting")) return true;
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  let lastPayload = "";

  function reportVideoRect() {
    const adPlaying = isAdPlaying();
    const video = findPlayerVideo();
    if (!video) {
      send({ found: false, isAd: adPlaying });
      return;
    }
    const r = video.getBoundingClientRect();

    // The element box can be wider than the picture when the player
    // letterboxes a differently-shaped stream. Solve for the drawn area so
    // the crop excludes black bars.
    const elementAspect = r.width / r.height;
    const videoAspect = video.videoWidth / video.videoHeight;
    let x = r.left;
    let y = r.top;
    let width = r.width;
    let height = r.height;
    if (isFinite(elementAspect) && isFinite(videoAspect) && videoAspect > 0) {
      if (elementAspect > videoAspect) {
        width = r.height * videoAspect;      // pillarboxed: bars left and right
        x = r.left + (r.width - width) / 2;
      } else if (elementAspect < videoAspect) {
        height = r.width / videoAspect;      // letterboxed: bars top and bottom
        y = r.top + (r.height - height) / 2;
      }
    }

    // Clip to the viewport — capture only ever sees what is on screen.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(vw, x + width);
    const y1 = Math.min(vh, y + height);

    if (x1 - x0 < 20 || y1 - y0 < 20) {
      send({ found: false, reason: "player is off screen", isAd: adPlaying });
      return;
    }

    send({
      found: true,
      isAd: adPlaying,
      rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      viewport: { width: vw, height: vh },
      native: { width: video.videoWidth, height: video.videoHeight },
      fullscreen: !!document.fullscreenElement
    });
  }

  function send(payload) {
    // Suppress identical repeats; this runs on every resize and on a timer.
    const encoded = JSON.stringify(payload);
    if (encoded === lastPayload) return;
    lastPayload = encoded;
    chrome.runtime
      .sendMessage({ target: "background", type: "video-rect", ...payload })
      .catch(() => {});
  }

  window.__scpReportVideoRect = reportVideoRect;

  window.addEventListener("resize", reportVideoRect, { passive: true });
  document.addEventListener("fullscreenchange", reportVideoRect);
  // Players swap elements when switching quality or entering theater mode.
  new MutationObserver(reportVideoRect).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"]
  });
  setInterval(reportVideoRect, 2000); // catches layout shifts nothing else fires for

  reportVideoRect();
})();
