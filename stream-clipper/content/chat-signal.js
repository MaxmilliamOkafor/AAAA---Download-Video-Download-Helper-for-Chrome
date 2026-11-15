// Live chat activity, for highlight detection.
//
// Runs on Twitch and Kick pages and inside YouTube's live-chat frame. Each
// new chat message is classified here, in the page (reaction? clip request?),
// and only per-second counts are sent on — the text of chat never leaves the
// tab. Nothing is read or sent until a chat list is actually on the page.

(() => {
  if (window.__scpChatSignal) return;
  window.__scpChatSignal = true;

  const host = location.hostname.replace(/^www\./, "");
  const SITE = host.endsWith("twitch.tv") ? "twitch" : host.endsWith("kick.com") ? "kick" : "youtube";

  // Message elements per site, most specific first. Site markup changes over
  // time; when none match, the dashboard reports the chat as not found rather
  // than guessing.
  const MESSAGE_SELECTORS = {
    twitch: [".chat-line__message", '[data-a-target="chat-line-message"]', ".seventv-message"],
    kick: ["[data-chat-entry]", ".chat-entry", "#chatroom-messages [data-index]"],
    youtube: ["yt-live-chat-text-message-renderer", "yt-live-chat-paid-message-renderer",
      "yt-live-chat-membership-item-renderer"]
  }[SITE];
  const CONTAINER_SELECTORS = {
    twitch: ['[data-test-selector="chat-scrollable-area__message-container"]',
      ".chat-scrollable-area__message-container", ".chat-list--default", ".chat-list"],
    kick: ["#chatroom-messages", "[data-chat-entry]", ".chat-entry"],
    youtube: ["#items.yt-live-chat-item-list-renderer", "yt-live-chat-item-list-renderer #items"]
  }[SITE];
  const SELECTOR = MESSAGE_SELECTORS.join(",");

  const counted = new WeakSet(); // virtualized lists re-insert the same nodes
  let bucket = { t: nowSecond(), messages: 0, hype: 0, clipCalls: 0 };
  let pending = [];
  let container = null;
  let observer = null;

  function nowSecond() {
    return Math.floor(Date.now() / 1000);
  }

  // Text of one message, with emotes as their names (they arrive as images).
  function messageText(el) {
    const body = el.querySelector("#message, [data-a-target='chat-message-text'], .chat-entry-content, .message-text") || el;
    let text = body.textContent || "";
    for (const img of body.querySelectorAll("img[alt]")) text += " " + img.alt;
    return text;
  }

  function roll() {
    const t = nowSecond();
    while (bucket.t < t) {
      pending.push(bucket);
      bucket = { t: bucket.t + 1, messages: 0, hype: 0, clipCalls: 0 };
      if (pending.length > 30) pending.shift(); // never let an asleep tab pile up
    }
  }

  function count(el) {
    if (counted.has(el)) return;
    counted.add(el);
    roll();
    const { hype, clipCall } = scpClassifyChat(messageText(el));
    bucket.messages += 1;
    if (hype) bucket.hype += 1;
    if (clipCall) bucket.clipCalls += 1;
  }

  function onMutations(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(SELECTOR)) count(node);
        else if (node.childElementCount && node.childElementCount < 60) {
          for (const el of node.querySelectorAll(SELECTOR)) count(el);
        }
      }
    }
  }

  function attach() {
    if (container && container.isConnected) return true;
    if (observer) observer.disconnect();
    container = null;
    for (const sel of CONTAINER_SELECTORS) {
      const found = document.querySelector(sel);
      if (found) {
        // Watch the list itself (or, if a message matched, its list).
        container = found.matches(SELECTOR) ? found.parentElement : found;
        break;
      }
    }
    if (!container) return false;
    // Messages already on screen are history, not activity: mark them seen.
    for (const el of container.querySelectorAll(SELECTOR)) counted.add(el);
    observer = new MutationObserver(onMutations);
    observer.observe(container, { childList: true, subtree: true });
    return true;
  }

  // Every two seconds: re-find the chat if the page swapped it out, then
  // hand over completed seconds. An empty second is still a sample — silence
  // is information — but only once a chat has been found.
  setInterval(() => {
    const found = attach();
    if (!found) {
      pending = [];
      chrome.runtime.sendMessage({ target: "background", type: "chat-signal", site: SITE, found: false, samples: [] }).catch(() => {});
      return;
    }
    roll();
    if (pending.length === 0) return;
    const samples = pending;
    pending = [];
    chrome.runtime.sendMessage({ target: "background", type: "chat-signal", site: SITE, found: true, samples }).catch(() => {});
  }, 2000);
})();
