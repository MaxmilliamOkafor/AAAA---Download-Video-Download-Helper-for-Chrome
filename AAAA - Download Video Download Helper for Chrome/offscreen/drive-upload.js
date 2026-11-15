// Google Drive delivery. Runs in the offscreen document because that is where
// clip blobs live; the service worker only supplies access tokens.
//
// Uses the Drive v3 resumable protocol in fixed-size chunks, so a multi-GB
// clip survives a dropped connection and never has to be sent as one request.
// Scope is drive.file: the extension can only see files it created itself.

const SCP_DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCP_DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
// Drive requires chunk sizes in multiples of 256 KiB.
const SCP_DRIVE_CHUNK = 64 * 256 * 1024; // 16 MiB
const SCP_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

// "parentId/name" -> folder id, so each folder is looked up once per session.
const scpDriveFolderCache = new Map();

// Pure: where the next chunk starts, given Drive's 308 "Range: bytes=0-N".
function scpDriveNextOffset(rangeHeader) {
  const m = /bytes=0-(\d+)/.exec(rangeHeader || "");
  return m ? Number(m[1]) + 1 : 0;
}

// Pure: escapes a value for a Drive `q` string literal.
function scpDriveEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function scpDriveFetch(url, init, getToken) {
  // One silent token refresh on 401, then give up with the real status.
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
    });
    if (res.status !== 401) return res;
  }
  throw new Error("Google Drive rejected the sign-in. Reconnect Drive in the dashboard.");
}

async function scpDriveEnsureFolder(name, parentId, getToken) {
  const key = `${parentId}/${name}`;
  if (scpDriveFolderCache.has(key)) return scpDriveFolderCache.get(key);

  const q =
    `name='${scpDriveEscape(name)}' and mimeType='${SCP_DRIVE_FOLDER_MIME}' ` +
    `and '${scpDriveEscape(parentId)}' in parents and trashed=false`;
  const found = await scpDriveFetch(
    `${SCP_DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    { method: "GET" },
    getToken
  );
  if (!found.ok) throw new Error(`Drive folder lookup failed (HTTP ${found.status})`);
  const list = await found.json();
  let id = list.files && list.files[0] && list.files[0].id;

  if (!id) {
    const created = await scpDriveFetch(
      `${SCP_DRIVE_API}/files?fields=id`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: SCP_DRIVE_FOLDER_MIME, parents: [parentId] })
      },
      getToken
    );
    if (!created.ok) throw new Error(`Drive folder creation failed (HTTP ${created.status})`);
    id = (await created.json()).id;
  }
  scpDriveFolderCache.set(key, id);
  return id;
}

// Uploads `blob` as `name` under folderPath (array of folder names from the
// Drive root). Resolves to { id, webViewLink }.
async function scpDriveUpload({ blob, name, folderPath, getToken, onProgress }) {
  let parentId = "root";
  for (const folder of folderPath || []) {
    parentId = await scpDriveEnsureFolder(folder, parentId, getToken);
  }

  const start = await scpDriveFetch(
    `${SCP_DRIVE_UPLOAD}?uploadType=resumable&fields=id,webViewLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": blob.type || "application/octet-stream",
        "X-Upload-Content-Length": String(blob.size)
      },
      body: JSON.stringify({ name, parents: [parentId] })
    },
    getToken
  );
  if (!start.ok) throw new Error(`Drive refused the upload (HTTP ${start.status})`);
  const sessionUrl = start.headers.get("Location");
  if (!sessionUrl) throw new Error("Drive did not return an upload session.");

  let offset = 0;
  let failures = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + SCP_DRIVE_CHUNK, blob.size);
    let res;
    try {
      // The session URL is itself the credential for the bytes.
      res = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}` },
        body: blob.slice(offset, end)
      });
    } catch (e) {
      res = null; // network drop: ask Drive how much it has, then resume
    }

    if (res && (res.status === 200 || res.status === 201)) {
      if (onProgress) onProgress(1);
      return res.json();
    }
    if (res && res.status === 308) {
      offset = scpDriveNextOffset(res.headers.get("Range")) || end;
      failures = 0;
      if (onProgress) onProgress(offset / blob.size);
      continue;
    }
    if (res && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new Error(`Drive upload failed (HTTP ${res.status})`);
    }

    if (++failures > 6) throw new Error("Drive upload kept failing — check your connection.");
    await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** failures)));
    const status = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${blob.size}` }
    }).catch(() => null);
    if (status && (status.status === 200 || status.status === 201)) return status.json();
    if (status && status.status === 308) offset = scpDriveNextOffset(status.headers.get("Range"));
  }
  throw new Error("Drive upload ended without a file.");
}

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, { scpDriveUpload, scpDriveNextOffset, scpDriveEscape });
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { scpDriveUpload, scpDriveNextOffset, scpDriveEscape, SCP_DRIVE_CHUNK };
}
