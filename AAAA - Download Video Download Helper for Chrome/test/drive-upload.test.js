// Tests the Drive uploader against an in-process imitation of Drive's
// resumable-upload protocol. Run: node test/drive-upload.test.js
const assert = require("assert");
const { scpDriveUpload, scpDriveNextOffset, scpDriveEscape, SCP_DRIVE_CHUNK } =
  require("../offscreen/drive-upload.js");

// A minimal Drive: folders, one resumable session, and switchable faults.
function fakeDrive({ dropChunk = -1, serverErrorChunk = -1, expireFirstToken = false } = {}) {
  const state = {
    folders: [],            // { id, name, parent }
    received: 0,
    total: 0,
    chunkCalls: 0,
    tokensSeen: [],
    folderLookups: 0,
    file: null,
    log: []
  };
  const json = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k] || null },
    json: async () => body
  });

  globalThis.fetch = async (url, init = {}) => {
    const auth = init.headers && init.headers.Authorization;
    if (auth) state.tokensSeen.push(auth);

    if (url.startsWith("https://www.googleapis.com/drive/v3/files?q=")) {
      if (expireFirstToken && auth === "Bearer token-1") return json(401, {});
      state.folderLookups++;
      const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)[1].replace(/\\(.)/g, "$1");
      const parent = /'([^']+)' in parents/.exec(q)[1];
      const hit = state.folders.find(f => f.name === name && f.parent === parent);
      return json(200, { files: hit ? [{ id: hit.id }] : [] });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?fields=id")) {
      const body = JSON.parse(init.body);
      const folder = { id: `folder-${state.folders.length + 1}`, name: body.name, parent: body.parents[0] };
      state.folders.push(folder);
      return json(200, { id: folder.id });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")) {
      const body = JSON.parse(init.body);
      state.total = Number(init.headers["X-Upload-Content-Length"]);
      state.file = { name: body.name, parent: body.parents[0], type: init.headers["X-Upload-Content-Type"] };
      return json(200, {}, { Location: "https://upload.example/session-1" });
    }
    if (url === "https://upload.example/session-1") {
      const range = init.headers["Content-Range"];
      if (range.startsWith("bytes */")) {
        // Status query: report how much has been stored.
        state.log.push("status");
        return state.received >= state.total
          ? json(200, { id: "file-1", webViewLink: "https://drive.example/file-1" })
          : json(308, {}, state.received ? { Range: `bytes=0-${state.received - 1}` } : {});
      }
      const call = state.chunkCalls++;
      const [, from, to] = /bytes (\d+)-(\d+)\//.exec(range).map(Number);
      if (call === dropChunk) { state.log.push("drop"); throw new TypeError("network error"); }
      if (call === serverErrorChunk) { state.log.push("503"); return json(503, {}); }
      assert.strictEqual(from, state.received, "chunk must start where the server left off");
      assert.strictEqual(init.body.size, to - from + 1, "Content-Range must match the bytes sent");
      state.received = to + 1;
      state.log.push(`chunk ${from}-${to}`);
      return state.received >= state.total
        ? json(200, { id: "file-1", webViewLink: "https://drive.example/file-1" })
        : json(308, {}, { Range: `bytes=0-${state.received - 1}` });
    }
    throw new Error("unexpected request: " + url);
  };
  return state;
}

// Skip the real backoff delays.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms, 1), ...args);

function tokens() {
  let n = 0;
  const calls = [];
  return { calls, get: async force => { calls.push(!!force); return `token-${++n}`; } };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

(async () => {
  await test("parses Drive's 308 Range header", () => {
    assert.strictEqual(scpDriveNextOffset("bytes=0-16777215"), 16777216);
    assert.strictEqual(scpDriveNextOffset(null), 0);
    assert.strictEqual(scpDriveNextOffset("garbage"), 0);
  });

  await test("escapes quotes and backslashes in folder names", () => {
    assert.strictEqual(scpDriveEscape("it's"), "it\\'s");
    assert.strictEqual(scpDriveEscape("a\\b"), "a\\\\b");
  });

  await test("chunk size is a multiple of 256 KiB, as Drive requires", () => {
    assert.strictEqual(SCP_DRIVE_CHUNK % (256 * 1024), 0);
  });

  const size = SCP_DRIVE_CHUNK * 2 + 12345; // three chunks, last one partial
  const blob = new Blob([new Uint8Array(size)], { type: "video/mp4" });

  await test("uploads in chunks into a nested folder it creates", async () => {
    const drive = fakeDrive();
    const t = tokens();
    const progress = [];
    const file = await scpDriveUpload({
      blob, name: "clip.mp4", folderPath: ["StreamClips", "O'Brien"], getToken: t.get,
      onProgress: f => progress.push(f)
    });
    assert.deepStrictEqual(file, { id: "file-1", webViewLink: "https://drive.example/file-1" });
    assert.strictEqual(drive.received, size);
    assert.strictEqual(drive.chunkCalls, 3);
    assert.deepStrictEqual(drive.folders.map(f => [f.name, f.parent]), [["StreamClips", "root"], ["O'Brien", "folder-1"]]);
    assert.deepStrictEqual(drive.file, { name: "clip.mp4", parent: "folder-2", type: "video/mp4" });
    assert.strictEqual(progress[progress.length - 1], 1);
    assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), "progress never goes backwards");
  });

  await test("reuses folders it already resolved instead of looking them up again", async () => {
    const drive = fakeDrive();
    drive.folders.push({ id: "folder-1", name: "StreamClips", parent: "root" }, { id: "folder-2", name: "O'Brien", parent: "folder-1" });
    await scpDriveUpload({ blob, name: "b.mp4", folderPath: ["StreamClips", "O'Brien"], getToken: tokens().get });
    assert.strictEqual(drive.folderLookups, 0, "cached from the previous upload");
    assert.strictEqual(drive.file.parent, "folder-2");
  });

  await test("resumes after a dropped connection without resending stored bytes", async () => {
    const drive = fakeDrive({ dropChunk: 1 });
    const file = await scpDriveUpload({ blob, name: "c.mp4", folderPath: ["StreamClips", "O'Brien"], getToken: tokens().get });
    assert.strictEqual(file.id, "file-1");
    assert.strictEqual(drive.received, size);
    assert.deepStrictEqual(drive.log, [
      `chunk 0-${SCP_DRIVE_CHUNK - 1}`, "drop", "status",
      `chunk ${SCP_DRIVE_CHUNK}-${SCP_DRIVE_CHUNK * 2 - 1}`, `chunk ${SCP_DRIVE_CHUNK * 2}-${size - 1}`
    ]);
  });

  await test("retries a chunk after a 503", async () => {
    const drive = fakeDrive({ serverErrorChunk: 0 });
    await scpDriveUpload({ blob, name: "d.mp4", folderPath: ["StreamClips", "O'Brien"], getToken: tokens().get });
    assert.strictEqual(drive.received, size);
    assert.strictEqual(drive.log[0], "503");
  });

  await test("refreshes the token once when Drive answers 401", async () => {
    const drive = fakeDrive({ expireFirstToken: true });
    const t = tokens();
    await scpDriveUpload({ blob, name: "e.mp4", folderPath: ["Fresh"], getToken: t.get });
    assert.strictEqual(t.calls[0], false);
    assert.strictEqual(t.calls[1], true, "second attempt forces a fresh token");
    assert.strictEqual(drive.received, size);
  });

  await test("gives up with a clear error on a permanent failure", async () => {
    fakeDrive();
    globalThis.fetch = async url =>
      url.includes("uploadType=resumable")
        ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }
        : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ files: [{ id: "x" }] }) };
    await assert.rejects(
      scpDriveUpload({ blob, name: "f.mp4", folderPath: ["Denied"], getToken: tokens().get }),
      /HTTP 403/
    );
  });

  console.log(`\n${passed} Drive upload tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
