// Helpers shared by the popup and the dashboard.

const ScpUI = (() => {
  function send(message) {
    return chrome.runtime
      .sendMessage({ target: "background", ...message })
      .catch(e => ({ ok: false, error: e.message }));
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) {
      if (child != null) node.append(child);
    }
    return node;
  }

  let toastTimer = null;
  function toast(text) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status" });
      document.body.append(node);
    }
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
  }

  function timeOfDay(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function dateTime(ms) {
    return new Date(ms).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  // { label, state } for one delivery leg of a clip, for a .status pill.
  function localStatus(clip) {
    switch (clip.local) {
      case "saved": return { label: "Saved", state: "ok" };
      case "saving": return { label: "Saving…", state: "busy" };
      case "failed": return { label: "Save failed", state: "error" };
      case "off": return { label: "Not kept", state: "" };
      // Entries written before delivery tracking existed were local saves.
      default: return { label: "Saved", state: "ok" };
    }
  }

  function driveStatus(clip) {
    switch (clip.drive) {
      case "uploaded": return { label: "In Drive", state: "ok" };
      case "uploading":
        return { label: `Uploading ${Math.round((clip.driveProgress || 0) * 100)}%`, state: "busy" };
      case "failed": return { label: "Upload failed", state: "error" };
      default: return { label: "Off", state: "" };
    }
  }

  function engineStatus(clip) {
    const name = clip.engineName === "supoclip" ? "SupoClip" : clip.engineName === "openshorts" ? "OpenShorts" : "Engine";
    switch (clip.engine) {
      case "sent": return { label: `In ${name}`, state: "ok" };
      case "sending": return { label: "Sending…", state: "busy" };
      case "failed": return { label: "Not sent", state: "error" };
      default: return { label: "—", state: "" };
    }
  }

  function statusPill({ label, state }, title) {
    return el("span", { class: "status", dataset: { state }, title: title || "", text: label });
  }

  function openDashboard(section) {
    const url = chrome.runtime.getURL(`dashboard/dashboard.html${section ? "#" + section : ""}`);
    chrome.tabs.create({ url });
  }

  return { send, el, toast, timeOfDay, dateTime, localStatus, driveStatus, engineStatus, statusPill, openDashboard };
})();
