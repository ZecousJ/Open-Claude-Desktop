import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { CloudEnvironments } from "../../electron/cloud/environments";
import { initialCloudEnvironment } from "../../shared/cloud-environments-api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Code homepage creation waits for a pending connector choice from the same frame", async () => {
  const lease = "11111111-1111-4111-8111-111111111111";
  const responses = (value: unknown, status = 200) => ({
    status, contentType: "application/json", body: Buffer.from(JSON.stringify(value)),
  });
  let release!: (status: number) => void;
  const paths: string[] = [];
  const action = negotiatedOfficialAction({
    mode: "engine-chat", accountId: "42", isCurrent: () => true,
    read: async () => responses({ version: 1, accountId: "42", activationLease: lease,
      mode: "engine-chat", textChat: { state: "ready", reason: "ready" } }),
    action: async (request) => {
      paths.push(request.path);
      if (request.method === "PATCH") {
        const status = await new Promise<number>((resolve) => { release = resolve; });
        return responses({}, status);
      }
      return responses({ session: { id: "fixture" } });
    },
  });
  const patch = { method: "PATCH" as const, path: "/api/account/settings", contentType: "application/json",
    body: Buffer.from(JSON.stringify({ enabled_mcp_tools: { [`${lease}:lookup`]: false } })) };
  const create = { method: "POST" as const, path: "/v1/code/sessions" };
  for (const status of [409, 200]) {
    const start = paths.length;
    const choice = action(patch);
    const send = action(create);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(paths.slice(start), [patch.path]);
    release(status);
    assert.equal((await choice).status, status);
    assert.equal((await send).status, status);
    assert.deepEqual(paths.slice(start), status === 200 ? [patch.path, create.path] : [patch.path]);
  }
});
import { bindOfficialFrame, normalizeOfficialFrameRequest } from "../../src-web/official/frame-lifecycle";
import { officialSkillUploadMaxBytes, officialUiActionPath, officialUiCapabilitiesPath, officialUiDefaultsPath, officialUiRequestMaxBytes, officialUiRequestLimit } from "../../shared/official-ui-web";
import { knowledgeFileLimit } from "../../shared/collections-api";
import { officialMelangeImportBodyBytes } from "../../shared/official-melange";
import { webLimits, webPaths } from "../../shared/web-protocol";
import { json, signedInBridge } from "./web-bridge-fakes.test";

test("Chat upload never stages bytes for the next account", async (t) => {
  const { bridge, tab, calls } = await signedInBridge();
  t.after(() => bridge.dispose());
  const route = "/api/11111111-1111-4111-8111-111111111111/upload";
  const body = new Uint8Array(300_000);
  let began!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  let byteWrites = 0;
  tab.routes.unshift(async (request) => {
    const endpoint = new URL(request.url, tab.env.origin).pathname;
    if (endpoint.endsWith("/web/uploads")) {
      began();
      await wait;
      return json({ ok: true, value: { id: "old-account-upload" } });
    }
    if (endpoint.includes("/uploads/old-account-upload/")) {
      byteWrites++;
      return json({ ok: true });
    }
  });
  const pending = bridge.officialUiAction({ method: "POST", path: route, body,
    contentType: "multipart/form-data; boundary=fixture" });
  await started;
  await bridge.auth.adopt({ access_token: "next-fixture", expires_in: 3600,
    account: { id: "43", email: "next@example.invalid", name: "Next" } });
  resume();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(byteWrites, 0);
  assert.ok(!calls.some((call) => call.method === "officialUiAction"));
});

test("aborting an original attachment action while staging prevents dispatch", async (t) => {
  const { bridge, tab, calls } = await signedInBridge();
  t.after(() => bridge.dispose());
  const controller = new AbortController();
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const staging = new Promise<void>(resolve => { finish = resolve; });
  tab.routes.unshift(async request => {
    if (!new URL(request.url, tab.env.origin).pathname.endsWith("/web/uploads")) return;
    begin();
    await staging;
    return json({ ok: true, value: { id: "cancelled-attachment-action" } });
  });
  const pending = bridge.officialUiAction({ method: "POST", path: officialUiActionPath,
    body: new Uint8Array(300_000), contentType: "application/proto" }, { signal: controller.signal });
  await started;
  controller.abort();
  finish();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(!calls.some(call => call.method === "officialUiAction"));
});

test("the original memory import sends large escaped JSON directly to the authenticated Runner", async t => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const route = `/api/organizations/${organization}/melange/import_external`;
  const pending = { status: "pending" };
  const { bridge, tab, calls } = await signedInBridge(method => method === "officialUiRead" ? {
    status: 200, contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify({
      version: 1, accountId: "42", activationLease: organization, mode: "engine-chat",
      textChat: { state: "ready", reason: "ready" },
    })),
  } : {
    status: 200, contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(pending)),
  });
  t.after(() => bridge.dispose());
  const negotiated = negotiatedOfficialAction({
    mode: "engine-chat", accountId: "42", isCurrent: () => true,
    read: bridge.officialUiRead, action: bridge.officialUiAction,
  });
  const fetch = createOfficialReadFetch(tab.env.origin, bridge.officialUiRead,
    async () => { throw Error("Unexpected native fetch"); }, undefined, negotiated);
  const body = JSON.stringify({ raw_export: "a" + "\u0000".repeat(65_534) + "a" });
  const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.deepEqual(await response.json(), pending);
  assert.deepEqual(calls.filter(call => call.method === "officialUiAction").map(call => call.args), [[{
    method: "POST", path: route, contentType: "application/json", capabilityLease: organization,
    body: new TextEncoder().encode(body),
  }]]);
  assert.equal((await fetch(route, { method: "POST", body: new Uint8Array(officialMelangeImportBodyBytes + 1) })).status, 413);
  assert.equal((await fetch(route + "?extra=1", { method: "POST", body: "{}" })).status, 501);
  assert.equal((await fetch(route)).status, 501);
});

test("the original skill version save transfers its multipart body and query with the active lease", async (t) => {
  const lease = "11111111-1111-4111-8111-111111111111";
  const route = `/api/organizations/${lease}/skills/upload-skill`;
  const path = `${route}?overwrite=true&check_skill_name=%66ixture-skill&wrap=true`;
  const name = "fixture-skill";
  const response = (data: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(data)),
  });
  const { bridge, tab, calls } = await signedInBridge((method) => {
    if (method === "officialUiRead") return response({
      version: 1, accountId: "42", activationLease: lease, mode: "engine-chat",
      textChat: { state: "ready", reason: "ready" },
    });
    if (method === "officialUiAction") return response({ skill: { name } });
  });
  t.after(() => bridge.dispose());
  const staged: Uint8Array[] = [];
  tab.routes.unshift((request) => {
    const endpoint = new URL(request.url, tab.env.origin).pathname;
    if (endpoint === webPaths.uploads || endpoint === `${webPaths.uploads}/skill-save/complete`)
      return json({ ok: true, value: { id: "skill-save" } });
    if (endpoint === `${webPaths.uploads}/skill-save/chunks/${staged.length}`) {
      assert.ok(request.body instanceof Uint8Array);
      assert.ok(request.body.byteLength <= webLimits.uploadChunkBytes);
      staged.push(request.body);
      return json({ ok: true });
    }
  });
  const negotiated = negotiatedOfficialAction({
    mode: "engine-chat", accountId: "42", isCurrent: () => true,
    read: bridge.officialUiRead, action: bridge.officialUiAction,
  });
  const frame = bindOfficialFrame({
    read: bridge.officialUiRead, action: negotiated, events: bridge.officialUiEvents,
  }, () => true, "/customize/skills", () => {});
  t.after(frame.dispose);
  const fetch = createOfficialReadFetch(tab.env.origin, frame.bindings.read,
    async () => { throw Error("Unexpected native fetch"); }, undefined, frame.bindings.action);
  const form = new FormData();
  const zip = new JSZip();
  zip.file("SKILL.md", `---\nname: ${name}\ndescription: A test skill\n---\n# Contents\n`);
  zip.file("references/fixture.bin", new Uint8Array(20 * 1024 * 1024 - 1024));
  const archive = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
  form.set("file", new File([archive], `${name}.skill`, { type: "application/zip" }));
  form.set("overwrite", "true");
  form.set("check_skill_name", name);
  form.set("wrap", "true");
  form.set("replaced_skill_id", "skill_0123456789abcdef01234567");
  const request = new Request(tab.env.origin + path, { method: "POST", body: form });
  const original = Buffer.from(await request.clone().arrayBuffer());
  assert.ok(original.byteLength > webLimits.linkFrameBytes);
  const saved = await fetch(request);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { skill: { name } });
  assert.ok(Buffer.concat(staged).equals(original), "the relay received every original multipart byte");
  assert.deepEqual(calls.map(({ method, args }) => ({ method, args })), [
    { method: "officialUiRead", args: [{ method: "GET", path: officialUiCapabilitiesPath }] },
    { method: "officialUiAction", args: [{
      method: "POST", path, capabilityLease: lease,
      contentType: request.headers.get("content-type"), body: { $upload: "skill-save" },
    }] },
  ]);
  assert.equal((await fetch(path, { method: "POST", body: new Uint8Array(22 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await fetch(route, { method: "PUT", body: form })).status, 501);
  assert.equal(calls.length, 2);
});

test("the original skill upload sends its full archive and delete sends inline JSON with the current lease", async (t) => {
  const lease = "11111111-1111-4111-8111-111111111111";
  const base = `/api/organizations/${lease}`;
  const uploadPath = `${base}/marketplaces/own-uploads/plugins/account-upload?overwrite=false&upload_source=customize`;
  const deletePath = `${base}/skills/delete-skill`;
  const { bridge, tab, calls } = await signedInBridge((method) => ({
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(method === "officialUiRead" ? {
      version: 1, accountId: "42", activationLease: lease, mode: "engine-chat",
      textChat: { state: "ready", reason: "ready" },
    } : { success: true })),
  }));
  t.after(() => bridge.dispose());
  const staged = new Map<string, Uint8Array[]>();
  tab.routes.unshift((request) => {
    const endpoint = new URL(request.url, tab.env.origin).pathname;
    if (endpoint === webPaths.uploads) {
      const id = `skill-upload-${staged.size + 1}`;
      staged.set(id, []);
      return json({ ok: true, value: { id } });
    }
    if (endpoint.startsWith(`${webPaths.uploads}/`)) {
      const [id, kind] = endpoint.slice(webPaths.uploads.length + 1).split("/");
      if (kind === "complete") return json({ ok: true, value: { id } });
      assert.equal(kind, "chunks");
      assert.ok(request.body instanceof Uint8Array);
      staged.get(id)!.push(request.body);
      return json({ ok: true });
    }
  });
  const action = negotiatedOfficialAction({
    mode: "engine-chat", accountId: "42", isCurrent: () => true,
    read: bridge.officialUiRead, action: bridge.officialUiAction,
  });
  const frame = bindOfficialFrame({ read: bridge.officialUiRead, action, events: bridge.officialUiEvents },
    () => true, "/customize/skills", () => {});
  t.after(frame.dispose);
  const fetch = createOfficialReadFetch(tab.env.origin, frame.bindings.read,
    async () => { throw Error("Unexpected native fetch"); }, undefined, frame.bindings.action);
  const form = new FormData();
  const zip = new JSZip();
  zip.file("SKILL.md", "---\nname: fixture-skill\ndescription: A test skill\n---\n# Contents\n");
  zip.file("references/fixture.bin", new Uint8Array(knowledgeFileLimit - 512));
  const archive = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
  form.set("file", new File([archive], "fixture-skill.skill"));
  const request = new Request(tab.env.origin + uploadPath, { method: "POST", body: form });
  const multipart = Buffer.from(await request.clone().arrayBuffer());
  assert.ok(multipart.byteLength > knowledgeFileLimit);
  assert.equal((await fetch(request)).status, 200);
  assert.ok(Buffer.concat([...staged.values()].flat()).equals(multipart));
  const body = JSON.stringify({ skill_id: "skill_0123456789abcdef01234567" });
  assert.equal((await fetch(deletePath, { method: "POST", body, headers: { "content-type": "application/json" } })).status, 200);
  assert.deepEqual(calls.filter(({ method }) => method === "officialUiAction").map(({ args }) => args), [
    [{ method: "POST", path: uploadPath, capabilityLease: lease, contentType: request.headers.get("content-type"),
      bodySegments: [{ $upload: "skill-upload-1" }, { $upload: "skill-upload-2" }] }],
    [{ method: "POST", path: deletePath, capabilityLease: lease, contentType: "application/json", body: new TextEncoder().encode(body) }],
  ]);
  assert.equal((await fetch(uploadPath.replace("own-uploads", "other"), { method: "POST", body: form })).status, 501);
  assert.equal((await fetch(`${deletePath}?unused=1`, { method: "POST", body })).status, 501);
  assert.equal((await fetch(uploadPath, { method: "POST", body: new Uint8Array(officialSkillUploadMaxBytes + 1) })).status, 413);
  assert.equal(calls.filter(({ method }) => method === "officialUiAction").length, 2);
});

test("original inclusive Cowork session query reaches the existing inclusive runner list", async () => {
  const calls: string[] = [];
  const fetch = createOfficialReadFetch('https://example.test', async request => {
    calls.push(request.path);
    return { status: 200, contentType: 'application/json', body: new TextEncoder().encode('{"data":[]}') };
  }, async () => { throw Error('Unexpected network'); });
  const response = await fetch('/v1/code/sessions?tags=cowork-remote&include_trigger_sessions=true&limit=100');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['/v1/code/sessions?tags=cowork-remote&limit=100']);
  assert.equal((await fetch('/v1/code/sessions?include_trigger_sessions=false')).status, 501);
  assert.equal((await fetch('/v1/code/sessions?include_trigger_sessions=true&include_trigger_sessions=true')).status, 501);
  assert.equal(calls.length, 1);
});

test("project file reads negotiate and decode compressed content without changing its bytes", async () => {
  const content = "Project knowledge\n" + "line,中文\n".repeat(600000);
  const bytes = new TextEncoder().encode(JSON.stringify({ content }));
  const fetch = createOfficialReadFetch("https://example.test", async request => {
    assert.equal(request.acceptEncoding, "gzip");
    return { status: 200, contentType: "application/json", body: gzipSync(bytes), bodyEncoding: "gzip" };
  }, async () => { throw Error("Unexpected network"); });
  const response = await fetch("/api/organizations/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222/docs/33333333-3333-4333-8333-333333333333");
  assert.equal(response.headers.get("Content-Length"), null);
  assert.ok((await response.json()).content === content, "large UTF-8 content is preserved after decompression");
});

test("project creation and instruction edits carry the supported text capacity", async () => {
  const project = "/api/organizations/11111111-1111-4111-8111-111111111111/projects";
  let writes = 0;
  const bridge = createOfficialReadFetch("https://example.test", async () => { throw Error("Unexpected read"); },
    async () => { throw Error("Unexpected network"); }, undefined, async request => {
      writes++;
      assert.equal(JSON.parse(new TextDecoder().decode(normalizeOfficialFrameRequest(request).body)).prompt_template.length, 100000);
      return { status: 201, contentType: "application/json", body: new TextEncoder().encode("{}") };
    });
  const body = '{"name":"Project","prompt_template":"' + "\\u4e2d".repeat(100000) + '"}';
  for (const [method, pathname] of [["POST", project], ["PUT", project + "/22222222-2222-4222-8222-222222222222"]]) {
    const payload = method === "POST" ? body : body.replace('"name":"Project",', "");
    assert.equal((await bridge(pathname, { method, headers: { "content-type": "application/json" }, body: payload })).status, 201);
    assert.equal((await bridge(pathname, { method, body: new Uint8Array(officialUiRequestLimit(method, pathname) + 1) })).status, 413);
  }
  assert.equal(writes, 2);
  assert.equal((await bridge(officialUiActionPath, { method: "POST", body: new Uint8Array(officialUiRequestLimit("POST", officialUiActionPath) + 1) })).status, 413);
});

test("official read fetch routes only the allowed same-origin reads through the bridge", async () => {
  const calls: string[] = [], native: string[] = [];
  const fetch = createOfficialReadFetch("https://example.test", async (request) => {
    calls.push(request.path); return { status: 200, contentType: "application/json", body: new TextEncoder().encode('{"ok":true}') };
  }, async (request) => { native.push((request as Request).url); return new Response("native"); });
  const response = await fetch("/api/account?test=1");
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, ["/api/account?test=1"]);
  assert.equal((await fetch("/api/v1/claudex/web/rpc/officialUiRead", { method: "POST" })).status, 200);
  assert.equal(native.length, 1, "the authenticated transport must not recurse");
  assert.equal((await fetch("/api/account", { method: "DELETE" })).status, 501);
  assert.equal((await fetch("/claudeai-rpc/anything", { method: "POST" })).status, 501);
  assert.equal((await fetch("/api/event_logging/v2/batch", { method: "POST", body: "private telemetry" })).status, 204);
  assert.equal((await fetch("/api/v2/rum", { method: "POST", body: "private telemetry" })).status, 204);
  assert.equal(calls.length, 1);
});

test("official file reads preserve opaque history IDs and generated PDF downloads", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const generated = "22222222-2222-4222-8222-222222222222";
  const calls: string[] = [];
  const fetch = createOfficialReadFetch("https://example.test", async (request) => {
    calls.push(request.path);
    return {
      status: 200,
      contentType: "application/pdf",
      body: new Uint8Array([1, 2, 3]),
      contentDisposition: 'attachment; filename="report.pdf"',
    };
  }, async () => { throw Error("Unexpected native fetch"); });
  const files = `/api/organizations/${organization}/files`;
  const preview = `${files}/historical_attachment-42/content_preview`;
  const converted = `/api/${organization}/files/${generated}/document_pdf`;
  assert.equal((await fetch(preview)).status, 200);
  assert.equal((await fetch(converted)).status, 200);
  const download = await fetch(`${files}/${generated}/contents`);
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="report.pdf"');
  assert.equal((await fetch(`${converted}?other=1`)).status, 501);
  assert.equal((await fetch(`${files}/historical_attachment-42/document_pdf`)).status, 501);
  assert.deepEqual(calls, [preview, converted, `${files}/${generated}/contents`]);
});

test("official actions use their own explicitly supplied transport", async () => {
  let reads = 0, writes = 0;
  const read = async () => { reads++; return { status: 200, contentType: "application/proto", body: new Uint8Array() }; };
  const native = async () => new Response();
  const disabled = createOfficialReadFetch("https://example.test", read, native);
  assert.equal((await disabled(officialUiActionPath, { method: "POST", body: new Uint8Array([1]) })).status, 501);
  const enabled = createOfficialReadFetch("https://example.test", read, native, undefined, async (request) => {
    writes++; assert.equal(request.path, officialUiActionPath); assert.deepEqual([...request.body!], [1, 2]);
    return { status: 200, contentType: "application/proto", body: new Uint8Array([3]) };
  });
  const response = await enabled(officialUiActionPath, { method: "POST", headers: { "content-type": "application/proto" }, body: new Uint8Array([1, 2]) });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [3]);
  assert.equal(writes, 1); assert.equal(reads, 0);
});

test("the one read-only POST preserves its bytes and rejects oversized bodies", async () => {
  let seen: any;
  const fetch = createOfficialReadFetch("https://example.test", async (request) => {
    seen = request; return { status: 200, contentType: "application/proto", body: new Uint8Array([4, 5]) };
  }, async () => new Response());
  const result = await fetch(officialUiDefaultsPath, { method: "POST", headers: { "content-type": "application/proto" }, body: new Uint8Array([1, 2, 3]) });
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [4, 5]);
  assert.deepEqual([...seen.body], [1, 2, 3]);
  assert.equal(seen.contentType, "application/proto");
  const oversized = await fetch(officialUiDefaultsPath, { method: "POST", headers: { "content-type": "application/proto" }, body: new Uint8Array(officialUiRequestMaxBytes + 1) });
  assert.equal(oversized.status, 413);
});

test("aborting an official read rejects without returning the later response", async () => {
  let release!: (value: any) => void;
  const fetch = createOfficialReadFetch("https://example.test", () => new Promise((resolve) => { release = resolve; }), async () => new Response());
  const controller = new AbortController();
  const pending = fetch("/api/account", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  release({ status: 200, contentType: "text/plain", body: new Uint8Array() });
});

test("aborting while a query body is read does not dispatch it", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  const fetch = createOfficialReadFetch("https://example.test", async () => {
    calls++; return { status: 200, contentType: "application/json", body: new Uint8Array() };
  }, async () => new Response());
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(value) { stream = value; } });
  const request = new Request(`https://example.test${officialUiDefaultsPath}`, {
    method: "POST", headers: { "content-type": "application/proto" }, body, signal: controller.signal, duplex: "half",
  } as RequestInit);
  const pending = fetch(request);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.equal(calls, 0);
  stream.close();
});

test("Code GitHub status reflects the current service connection and preserves failures", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  let status = { configured: true, connected: true, login: "fixture" };
  let failure = false;
  const fetch = createOfficialReadFetch("https://example.test", async () => { throw Error("unexpected runner read"); },
    async () => { throw Error("unexpected network request"); }, undefined, undefined, undefined, undefined, {
      organization, githubStatus: async () => { if (failure) throw Error("service unavailable"); return status; },
    });
  const path = `/api/organizations/${organization}/sync/github/auth`;
  assert.deepEqual(await (await fetch(path)).json(), { is_authenticated: true, user_login: "fixture" });
  status = { configured: true, connected: false, login: "" };
  assert.deepEqual(await (await fetch(path)).json(), { is_authenticated: false });
  failure = true;
  assert.equal((await fetch(path)).status, 503);
  assert.equal((await fetch(path.replace(organization, "22222222-2222-4222-8222-222222222222"))).status, 501);
});

test("original Code GitHub connect and disconnect use the signed-in service", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const authorizeUrl = "https://github.com/login/oauth/authorize?state=fixture";
  const path = `/api/organizations/${organization}/sync/github/auth`;
  let connected = true;
  let starts = 0;
  const send = createOfficialReadFetch("https://example.test", async () => assert.fail("unexpected Runner request"),
    async () => assert.fail("unexpected network request"), undefined, undefined, undefined, undefined, {
      organization,
      githubStatus: async () => ({ configured: true, connected }),
      githubConnect: async () => { starts++; return { authorizeUrl }; },
      githubDisconnect: async () => {
        connected = false;
        return { configured: true, connected };
      },
    });
  const start = (body: object, headers?: HeadersInit) =>
    send(path + "/start", { method: "POST", body: JSON.stringify(body), headers });
  const request = {
    pre_auth_state: { origin: "/code?github_success=epitaxy_repo_cluster", setup_entrypoint: "repo_picker" },
    ghe_config_id: null,
  };

  assert.equal((await start(request, { "x-organization-uuid": "another-organization" })).status, 404);
  assert.equal((await start({ ...request, ghe_config_id: "enterprise" })).status, 400);
  assert.equal((await start({ ...request, pre_auth_state: { intent: "install" } })).status, 400);
  assert.equal(starts, 0);

  const result = await start(request);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { redirect_url: authorizeUrl });
  assert.equal(starts, 1);

  assert.deepEqual(await (await send(path)).json(), { is_authenticated: true });
  assert.deepEqual(await (await send(path, { method: "DELETE" })).json(), { is_authenticated: false });
  assert.deepEqual(await (await send(path)).json(), { is_authenticated: false });
});

test("original Code lists empty repositories until the account connects GitHub", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  let code = "CLAUDEX_GITHUB_NOT_CONFIGURED";
  const send = createOfficialReadFetch("https://example.test", async () => assert.fail("unexpected Runner request"),
    async () => assert.fail("unexpected network request"), undefined, undefined, undefined, undefined, {
      organization,
      githubRepositories: async () => { throw Object.assign(Error("GitHub unavailable"), { code }); },
    });
  const path = `/api/organizations/${organization}/code/repos`;
  assert.deepEqual(await (await send(path)).json(), { repos: [], next_page: null, has_more: false });
  code = "CLAUDEX_GITHUB_NOT_CONNECTED";
  assert.deepEqual(await (await send(path + "/search?q=fixture")).json(), []);
  code = "CLAUDEX_GITHUB_UNAVAILABLE";
  assert.equal((await send(path)).status, 503);
});

test("Code branch picker reads every page for the active organization", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const calls: unknown[] = [];
  const fetch = createOfficialReadFetch("https://example.test", async () => { throw Error("unexpected runner read"); },
    async () => { throw Error("unexpected network request"); }, undefined, undefined, undefined, undefined, {
      organization, githubBranches: async (input) => {
        calls.push(input);
        return input.page === undefined
          ? { items: [{ name: "main", protected: true }], defaultBranch: "main", nextPage: 2, truncated: false }
          : { items: [{ name: "feature", protected: false }], defaultBranch: "main", nextPage: null, truncated: false };
      },
    });
  const path = `/api/github/organizations/${organization}/github/fixture/repo/branches`;
  assert.deepEqual(await (await fetch(path + "?query=fea")).json(), {
    data: [{ name: "main", protected: true }, { name: "feature", protected: false }],
  });
  assert.deepEqual(calls, [
    { repository: "fixture/repo", query: "fea", page: undefined },
    { repository: "fixture/repo", query: "fea", page: 2 },
  ]);
  assert.equal((await fetch(path + "?ghe_configuration_id=7")).status, 400);
  assert.equal((await fetch(path.replace(organization, "22222222-2222-4222-8222-222222222222"))).status, 501);
  assert.equal(calls.length, 2);
});

test("Code draft lists the active account's Runner profiles and GitHub repositories", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const foreignOrganization = "22222222-2222-4222-8222-222222222222";
  const foreignEnvironments = `/v1/environment_providers/private/organizations/${foreignOrganization}/environments?limit=1000`;
  const calls: unknown[] = [];
  const fetch = createOfficialReadFetch("https://example.test", async () => { throw Error("unexpected read"); },
    async () => { throw Error("unexpected network request"); }, undefined, undefined, undefined, undefined, {
      organization,
      cloudEnvironments: { accountUuid: "fixture-account", api: { listCloudEnvironments: async () => [initialCloudEnvironment] } },
      githubRepositories: async (input) => {
        calls.push(input);
        return { items: [{ fullName: "fixture/repo", name: "repo", owner: "fixture", private: true,
          description: "", defaultBranch: "main", cloneUrl: "https://github.com/fixture/repo.git" }], nextPage: null, truncated: false };
      },
    });
  const envs = `/v1/environment_providers/private/organizations/${organization}/environments?limit=1000`;
  const environment = await (await fetch(envs)).json();
  assert.deepEqual(environment.environments.map((entry: any) => [entry.environment_id, entry.name, entry.state]), [["default", "Default", "active"]]);
  const repos = await (await fetch(`/api/organizations/${organization}/code/repos?skip_status=true&page=2&per_page=100`)).json();
  assert.equal(repos.repos[0].repo.full_name, "fixture/repo");
  assert.equal(repos.repos[0].repo.owner.login, "fixture");
  assert.equal(repos.repos[0].status, undefined);
  assert.deepEqual(calls, [{ page: 2, perPage: 100, query: undefined }]);
  assert.equal((await fetch(foreignEnvironments)).status, 404);
});

test("original Code environment requests persist and reload the active account's Runner profiles", async (t) => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const otherOrganization = "22222222-2222-4222-8222-222222222222";
  const accountUuid = "33333333-3333-4333-8333-333333333333";
  const root = mkdtempSync(join(tmpdir(), "official-code-environments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unexpected = () => { throw Error("unexpected request outside the current account"); };
  const profiles = () => new CloudEnvironments(root);
  const listCloudEnvironments = async () => profiles().list();
  const fetch = createOfficialReadFetch("https://example.test", unexpected, unexpected, undefined, undefined, undefined, undefined, {
    organization,
    cloudEnvironments: { accountUuid, api: { listCloudEnvironments, mutations: {
      saveCloudEnvironment: async (input) => profiles().save(input),
      archiveCloudEnvironment: async (id) => profiles().archive(id),
    } } },
  });
  const path = `/v1/environment_providers/private/organizations/${organization}`;
  const post = (pathname: string, body?: unknown, org = organization) => fetch(pathname, {
    method: "POST", headers: { "Content-Type": "application/json", "x-organization-uuid": org }, body: JSON.stringify(body),
  });
  const variables = { SERVICE: '  a # "quote" \\n\r\n  ', EMPTY: "" };
  const config = {
    environment_type: "anthropic", cwd: "/home/user", init_script: "echo ready", environment: variables,
    languages: [{ name: "python", version: "3.11" }, { name: "node", version: "20" }],
    network_config: { allowed_hosts: ["*.example.com"], allow_default_hosts: false },
  };
  const payload = { name: "Fixture", kind: "anthropic_cloud", description: "", config };
  const originalDefault = await (await post(`${path}/cloud/ensure_default`)).json();
  assert.equal(originalDefault.environment_id, "default");
  assert.equal(originalDefault.is_ccr_default, true);
  assert.equal(originalDefault.config.init_script, null);
  assert.equal((await post(path.replace(organization, otherOrganization) + "/cloud/create", payload)).status, 404);
  assert.equal((await post(`${path}/cloud/create`, payload, otherOrganization)).status, 404);
  assert.equal((await post(`${path}/cloud/create`, { ...payload, scope: "organization" })).status, 400);
  assert.equal((await post(`${path}/cloud/create`, { ...payload, config: { ...config, environment: { CODEX_HOME: "/tmp" } } })).status, 400);
  assert.equal((await post(`${path}/cloud/create`, { ...payload, config: { ...config, environment: JSON.parse('{"__proto__":"x"}') } })).status, 400);
  assert.equal((await post(`${path}/cloud/create`, { ...payload, config: { ...config, network_config: { allowed_hosts: ["*", "example.com"], allow_default_hosts: true } } })).status, 400);
  const created = await post(`${path}/cloud/create`, payload);
  assert.equal(created.status, 200);
  const detail = await created.json();
  assert.equal(detail.name, "Fixture");
  assert.equal(detail.scope, "account");
  assert.equal(detail.owner_account_uuid, accountUuid);
  assert.deepEqual(detail.config, config);
  const id = detail.environment_id;
  assert.equal(profiles().get(id).network, "custom");
  const listed = await (await fetch(`${path}/environments?limit=1000`)).json();
  assert.deepEqual(listed.environments.map((row: { environment_id: string }) => row.environment_id), ["default", id]);
  assert.equal(listed.environments[1].config.environment, undefined);
  assert.deepEqual(await (await fetch(`${path}/environments/${id}`)).json(), detail);

  const fullNetwork = { allowed_hosts: ["*"], allow_default_hosts: true };
  const updated = await post(`${path}/environments/${id}`, { name: "Renamed", description: "", config: { ...detail.config, network_config: fullNetwork } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, "Renamed");
  assert.equal(profiles().get(id).network, "full");
  assert.deepEqual((await (await fetch(`${path}/environments/${id}`)).json()).config.network_config, fullNetwork);
  assert.equal((await post(`${path}/environments/default/archive`, {})).status, 400);
  assert.equal((await post(`${path}/environments/${id}/archive`, {})).status, 204);
  assert.equal((await fetch(`${path}/environments/${id}`)).status, 404);
  assert.equal((await post(`${path}/environments/${id}/archive`, {})).status, 404);
  assert.deepEqual(profiles().list(), [initialCloudEnvironment]);
  assert.deepEqual(await (await post(`${path}/cloud/ensure_default`)).json(), originalDefault);
});

test("Code session creation forwards the original body and organization to the action", async () => {
  let seen: any;
  const fetch = createOfficialReadFetch("https://example.test", async () => { throw Error("unexpected read"); },
    async () => { throw Error("unexpected network"); }, undefined, async (request) => {
      seen = request; return { status: 200, contentType: "application/json", body: new TextEncoder().encode('{}') };
    });
  const payload = JSON.stringify({ environment_id: "default", config: { sources: [{ type: "git_repository", url: "https://github.com/fixture/repo", revision: "refs/heads/feature" }] }, events: [] });
  const response = await fetch("/v1/code/sessions", { method: "POST", headers: { "Content-Type": "application/json", "x-organization-uuid": "fixture-org" }, body: payload });
  assert.equal(response.status, 200);
  assert.equal(seen.codeOrganizationId, "fixture-org");
  assert.equal(new TextDecoder().decode(seen.body), payload);
});
