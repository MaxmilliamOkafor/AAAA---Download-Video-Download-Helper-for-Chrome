// Hands clips to a self-hosted shorts engine, which reframes them to 9:16,
// adds captions and hooks, and picks the best moments inside them.
//
// Two engines are supported, each through its own public HTTP API. No code
// from either project is included here: StreamClip talks to them over the
// network, as separate programs.
//
//   OpenShorts (MIT) — github.com/mutonby/openshorts
//     POST {base}/api/process   multipart: file, acknowledged=true
//     optional header X-Gemini-Key; answers { job_id, status }
//
//   SupoClip (AGPL-3.0) — github.com/FujiwaraChoki/supoclip
//     POST {base}/upload        multipart: video; Authorization: Bearer sk_…
//                               answers { video_path: "upload://…" }
//     POST {base}/tasks/        JSON { source: { url: video_path }, clip_length }
//                               answers { task_id }
//
// Runs in the offscreen document, where clip blobs live. Returns
// { engine, jobId } or throws an Error whose message is shown to the user.

const SCP_ENGINE_TIMEOUT_MS = 10 * 60 * 1000; // a large upload on a slow link

// Turns an HTTP failure into a sentence a person can act on.
async function scpEngineError(res, engineName) {
  let detail = "";
  try {
    const body = await res.clone().json();
    detail = typeof body.detail === "string" ? body.detail
      : body.detail && typeof body.detail.message === "string" ? body.detail.message
      : typeof body.message === "string" ? body.message
      : typeof body.error === "string" ? body.error
      : "";
  } catch {
    try { detail = (await res.text()).slice(0, 200); } catch { /* none */ }
  }
  const hint =
    res.status === 401 || res.status === 403 ? " Check the API key in the dashboard." :
    res.status === 402 ? ` ${engineName} reports no plan or credits for this account.` :
    res.status === 413 ? " The clip is larger than the server accepts." :
    "";
  return new Error(`${engineName} answered HTTP ${res.status}${detail ? `: ${detail}` : ""}.${hint}`);
}

async function scpEngineFetch(url, init, engineName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCP_ENGINE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`${engineName} did not answer within 10 minutes.`);
    throw new Error(`Could not reach ${engineName} at ${new URL(url).origin} — is it running?`);
  } finally {
    clearTimeout(timer);
  }
}

const SCP_ENGINE_CLIP_SECONDS = {
  // OpenShorts takes explicit bounds; SupoClip takes a named preset.
  auto: null,
  short: [15, 30],
  medium: [30, 60],
  long: [60, 120]
};

async function scpSendToOpenShorts({ base, key, blob, filename, clipLength }) {
  const form = new FormData();
  form.append("file", blob, filename);
  // OpenShorts requires the uploader to confirm rights to the content. The
  // extension only sends this after the user has confirmed it themselves.
  form.append("acknowledged", "true");
  const bounds = SCP_ENGINE_CLIP_SECONDS[clipLength];
  if (bounds) {
    form.append("clip_min_seconds", String(bounds[0]));
    form.append("clip_max_seconds", String(bounds[1]));
  }
  const headers = {};
  if (key) headers["X-Gemini-Key"] = key;
  const res = await scpEngineFetch(`${base}/api/process`, { method: "POST", body: form, headers }, "OpenShorts");
  if (!res.ok) throw await scpEngineError(res, "OpenShorts");
  const body = await res.json();
  if (!body || !body.job_id) throw new Error("OpenShorts accepted the upload but returned no job id.");
  return { engine: "openshorts", jobId: String(body.job_id) };
}

async function scpSendToSupoClip({ base, key, blob, filename, clipLength, title }) {
  if (!key) throw new Error("SupoClip needs an API key (Agents & API → create key) in the dashboard.");
  const auth = { Authorization: `Bearer ${key}` };

  const form = new FormData();
  form.append("video", blob, filename);
  const upload = await scpEngineFetch(`${base}/upload`, { method: "POST", body: form, headers: auth }, "SupoClip");
  if (!upload.ok) throw await scpEngineError(upload, "SupoClip");
  const { video_path: videoPath } = await upload.json();
  if (!videoPath) throw new Error("SupoClip stored the upload but returned no video path.");

  const task = await scpEngineFetch(`${base}/tasks/`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { url: videoPath, title: title || filename },
      clip_length: clipLength || "auto"
    })
  }, "SupoClip");
  if (!task.ok) throw await scpEngineError(task, "SupoClip");
  const body = await task.json();
  const id = body && (body.task_id || body.id);
  if (!id) throw new Error("SupoClip created no task for the upload.");
  return { engine: "supoclip", jobId: String(id) };
}

async function scpSendToShortsEngine(request) {
  if (request.engine === "openshorts") return scpSendToOpenShorts(request);
  if (request.engine === "supoclip") return scpSendToSupoClip(request);
  throw new Error(`Unknown shorts engine: ${request.engine}`);
}

if (typeof globalThis !== "undefined") Object.assign(globalThis, { scpSendToShortsEngine });
if (typeof module !== "undefined" && module.exports) module.exports = { scpSendToShortsEngine };
