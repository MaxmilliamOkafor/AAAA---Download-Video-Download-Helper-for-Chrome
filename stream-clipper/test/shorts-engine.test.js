// Tests the shorts-engine client against imitations of the OpenShorts and
// SupoClip HTTP APIs, as their source code defines them.
// Run: node test/shorts-engine.test.js
const assert = require("assert");
const { scpSendToShortsEngine } = require("../offscreen/shorts-engine.js");

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
const blob = new Blob([new Uint8Array(4096)], { type: "video/mp4" });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

(async () => {
  await test("OpenShorts: posts the file with the rights flag and clip bounds", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init, form: Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `blob:${v.size}:${v.name}`])) });
      return json(200, { job_id: "job-42", status: "queued" });
    };
    const out = await scpSendToShortsEngine({ engine: "openshorts", base: "http://localhost:8000", key: "AIza-test", blob, filename: "clip.mp4", clipLength: "short" });
    assert.deepStrictEqual(out, { engine: "openshorts", jobId: "job-42" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "http://localhost:8000/api/process");
    assert.deepStrictEqual(calls[0].form, { file: "blob:4096:clip.mp4", acknowledged: "true", clip_min_seconds: "15", clip_max_seconds: "30" });
    assert.strictEqual(calls[0].init.headers["X-Gemini-Key"], "AIza-test");
  });

  await test("OpenShorts: no key sends no key header, auto sends no bounds", async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = init; return json(200, { job_id: "j" }); };
    await scpSendToShortsEngine({ engine: "openshorts", base: "http://h:8000", key: "", blob, filename: "a.mp4", clipLength: "auto" });
    assert.deepStrictEqual(seen.headers, {});
    assert.deepStrictEqual([...seen.body.keys()], ["file", "acknowledged"]);
  });

  await test("OpenShorts: a missing Gemini key surfaces the server's own message", async () => {
    globalThis.fetch = async () => json(400, { detail: "GEMINI_API_KEY is not configured" });
    await assert.rejects(
      scpSendToShortsEngine({ engine: "openshorts", base: "http://h:8000", blob, filename: "a.mp4" }),
      /OpenShorts answered HTTP 400: GEMINI_API_KEY is not configured/
    );
  });

  await test("SupoClip: uploads, then creates a task from the stored path", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/upload")) return json(200, { message: "Video uploaded successfully", video_path: "upload://abc.mp4" });
      if (url.endsWith("/tasks/")) return json(200, { task_id: "task-7" });
      throw new Error("unexpected " + url);
    };
    const out = await scpSendToShortsEngine({ engine: "supoclip", base: "http://localhost:8000", key: "sk_test", blob, filename: "clip.mp4", clipLength: "medium", title: "silky highlight" });
    assert.deepStrictEqual(out, { engine: "supoclip", jobId: "task-7" });
    assert.strictEqual(calls[0].url, "http://localhost:8000/upload");
    assert.strictEqual(calls[0].init.headers.Authorization, "Bearer sk_test");
    assert.strictEqual(calls[0].init.body.get("video").size, 4096);
    assert.strictEqual(calls[1].url, "http://localhost:8000/tasks/");
    assert.strictEqual(calls[1].init.headers.Authorization, "Bearer sk_test");
    assert.deepStrictEqual(JSON.parse(calls[1].init.body), {
      source: { url: "upload://abc.mp4", title: "silky highlight" }, clip_length: "medium"
    });
  });

  await test("SupoClip: refuses to send without an API key, before any request", async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return json(200, {}); };
    await assert.rejects(scpSendToShortsEngine({ engine: "supoclip", base: "http://h", key: "", blob, filename: "a.mp4" }), /needs an API key/);
    assert.strictEqual(called, false);
  });

  await test("SupoClip: a rejected key says to check it", async () => {
    globalThis.fetch = async () => json(401, { detail: "Invalid API key" });
    await assert.rejects(
      scpSendToShortsEngine({ engine: "supoclip", base: "http://h", key: "sk_bad", blob, filename: "a.mp4" }),
      /HTTP 401: Invalid API key\. Check the API key/
    );
  });

  await test("an engine that is not running gives a clear error", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(
      scpSendToShortsEngine({ engine: "openshorts", base: "http://localhost:8000", blob, filename: "a.mp4" }),
      /Could not reach OpenShorts at http:\/\/localhost:8000 — is it running\?/
    );
  });

  await test("an unknown engine is rejected", async () => {
    await assert.rejects(scpSendToShortsEngine({ engine: "nope", base: "http://h", blob, filename: "a.mp4" }), /Unknown shorts engine/);
  });

  console.log(`\n${passed} shorts engine tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
