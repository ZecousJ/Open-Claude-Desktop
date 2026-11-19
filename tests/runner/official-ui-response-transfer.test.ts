import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { crc32, deflateSync, gzipSync } from "node:zlib";
import JSZip from "jszip";
import {
  CloudClient,
  type CloudSession,
} from "../../electron/cloud/cloud-client";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { localWorkingTree } from "../../electron/git/working-tree";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";
import { captureOutputFiles } from "../../electron/artifacts/generated-files";
import { readOwnedTurnAttachment } from "../../electron/ipc/owned-turn-attachment";
import { storeAttachment } from "../../electron/engine/composer-files";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { Store } from "../../electron/store/store";
import { extractKnowledgeDocument } from "../../electron/workspace/knowledge-document";
import { openPolicy } from "../../shared/client-policy";
import { knowledgeFileLimit } from "../../shared/collections-api";
import {
  officialResponseChunkBytes,
  officialResponseChunkPath,
  officialResponseChunkPrefix,
} from "../../shared/official-response-transfer";
import {
  isOfficialUiQuery,
  officialUiCapabilitiesPath,
  officialUiReadMaxBytes,
  type OfficialUiWireRequest,
  type OfficialUiWireResponse,
} from "../../shared/official-ui-web";
import {
  parseRpcRequest,
  webLimits,
  webPaths,
} from "../../shared/web-protocol";
import type { RunnerFrame } from "../../shared/web-runner-frames";
import type { Conversation, Mode } from "../../shared/types";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { json, signedInBridge } from "../app/web-bridge-fakes.test";
import { imageSizeFixtures } from "../fixtures/official-image-size-data";
import { knowledgeDocx } from "../support/knowledge-document-fixtures";
import { useElectronShim } from "./runner-core-support.test";

const hostPlatform = process.platform;
useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");

function scannedPdf(size: number) {
  const width = 2048,
    height = Math.floor((size - 2048) / width);
  const pixels = randomBytes(width * height);
  const commands = "q 612 0 0 792 0 0 cm /Im Do Q\n";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>",
    ),
    Buffer.from(
      `<< /Length ${commands.length} >>\nstream\n${commands}endstream`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
      ),
      pixels,
      Buffer.from("\nendstream"),
    ]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  let offset = parts[0].length;
  const xref = objects.map((object, i) => {
    const line = `${String(offset).padStart(10, "0")} 00000 n \n`;
    const head = Buffer.from(`${i + 1} 0 obj\n`),
      tail = Buffer.from("\nendobj\n");
    parts.push(head, object, tail);
    offset += head.length + object.length + tail.length;
    return line;
  });
  const trailer = Buffer.from(
    `xref\n0 6\n0000000000 65535 f \n${xref.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%`,
  );
  const eof = Buffer.from("\n%%EOF\n");
  return Buffer.concat([
    ...parts,
    trailer,
    Buffer.alloc(size - offset - trailer.length - eof.length, " "),
    eof,
  ]);
}

function fixture(t: TestContext, officialUi = true, modes: Mode[] = ["chat"]) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-response-transfer-"),
  );
  t.after(async () => {
    if (modes.includes("code"))
      await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const projectId = "22222222-2222-4222-8222-222222222222";
  const replies = new Map<string, Extract<RunnerFrame, { t: "result" }>>();
  const uploads = new Map<string, Uint8Array>();
  let now = 1,
    sequence = 0;
  let onUploadRead: (() => void) | undefined;
  const dispatcher = new Dispatcher({
    officialUiRoot: officialUi ? path.resolve("build/official-ui") : undefined,
    officialUiActions: officialUi,
    guard: { modes },
    runtime: {
      serviceUrl: "http://unused",
      stateDir: root,
      providerServiceScript: "unused",
      version: "test",
      codexBinary: () => "unused",
    },
    link: {
      send(frame) {
        assert.equal(frame.t, "result");
        replies.set(frame.id, frame);
        return true;
      },
      async request(op, userId, raw) {
        assert.equal(op, "store.files.get");
        assert.equal(userId, 1);
        const { id, offset, length } = raw as {
          id: string;
          offset: number;
          length: number;
        };
        const data = uploads.get(id);
        assert.ok(data);
        onUploadRead?.();
        return encodeWireValue({
          size: data.length,
          bytes: data.subarray(offset, offset + length),
        });
      },
    },
    publish() {},
    openUrl() {},
    log() {},
    now: () => now,
  });
  const contexts = [1, 2].map((userId) => {
    const store = new Store(path.join(root, String(userId)));
    store.projects = [
      {
        id: projectId,
        kind: "chat",
        name: "Owned project",
        description: "",
        instructions: "",
        createdAt: 1,
      },
    ];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const calls: string[] = [];
    handlers.set("snapshot", () => ({
      projects: store.projects,
      conversations: [],
    }));
    registerCollectionHandlers(
      (name, handler) =>
        handlers.set(name, (...args) => {
          calls.push(name);
          return handler(...args);
        }),
      {
        store,
        onSettingsChanged() {},
        onAccountActivated() {},
        onAccountDeactivating() {},
      } as never,
    );
    let identity = {};
    const ctx = {
      userId,
      store,
      handlers,
      activeAccount: { id: `owner-${userId}` },
      appVersion: "test",
      signedOut: false,
      closedFlag: false,
      get accountRetiring() {
        return this.closedFlag || this.signedOut || !this.activeAccount;
      },
      get closed() {
        return this.closedFlag;
      },
      officialSessionIdentity: () => identity,
      engine: {},
      engineFor: () => ({}),
      onEvent: () => () => {},
      setAccessToken() {},
      log() {},
    };
    dispatcher.contexts.set(userId, ctx as never);
    return {
      ctx,
      calls,
      rotate: () => {
        identity = {};
      },
    };
  });
  const invoke = async (method: string, args: unknown[], userId = 1) => {
    const id = String(++sequence);
    await dispatcher.call({
      t: "call",
      id,
      method,
      deadlineMs: webLimits.callTimeoutMs,
      user: { id: userId, accessToken: "fixture" },
      args,
    });
    const frame = replies.get(id);
    assert.ok(frame);
    replies.delete(id);
    assert.ok(
      Buffer.byteLength(JSON.stringify(frame)) <= webLimits.linkFrameBytes,
    );
    return frame;
  };
  const run = (
    request: OfficialUiWireRequest,
    userId = 1,
    method = "officialUiRead",
  ) => invoke(method, [encodeWireValue(request)], userId);
  const read = async (request: OfficialUiWireRequest, userId?: number) => {
    const frame = await run(request, userId);
    assert.equal(frame.ok, true, frame.error?.message);
    return decodeWireValue(frame.value) as OfficialUiWireResponse;
  };
  const org = `/api/organizations/${organizationUuid("owner-1")}`;
  const base = `${org}/projects/${projectId}`;
  const addFiles = async (files: { name: string; data: Uint8Array }[]) => {
    const handler = contexts[0].ctx.handlers.get("addProjectKnowledgeFiles");
    assert.ok(handler);
    await handler(projectId, files);
  };
  const seed = async (name: string, data: Uint8Array) => {
    await addFiles([{ name, data }]);
    const listed = await read({ method: "GET", path: `${base}/files` });
    const files = JSON.parse(Buffer.from(listed.body).toString());
    const file = files.find(
      (row: { file_name: string }) => row.file_name === name,
    );
    assert.ok(file);
    return {
      preview: String(file.preview_url),
      contents: `${org}/files/${file.file_uuid}/contents`,
    };
  };
  return {
    addFiles,
    dispatcher,
    invoke,
    run,
    read,
    seed,
    uploads,
    base,
    contexts,
    projectId,
    knowledgeFolder: path.join(
      contexts[0].ctx.store.root,
      "projects",
      projectId,
      "knowledge",
    ),
    onUploadRead: (callback: () => void) => {
      onUploadRead = callback;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function uploadResponse(
  uploads: Map<string, Uint8Array>,
  endpoint: string,
  body: unknown,
) {
  if (endpoint === webPaths.uploads) {
    assert.ok(
      body &&
        typeof body === "object" &&
        "size" in body &&
        typeof body.size === "number",
    );
    const id = `upload-${uploads.size + 1}`;
    uploads.set(id, new Uint8Array(body.size));
    return json({ ok: true, value: { id } });
  }
  const piece = /\/uploads\/(upload-\d+)\/chunks\/(\d+)$/.exec(endpoint);
  if (piece) {
    const data = uploads.get(piece[1]);
    assert.ok(data && body instanceof Uint8Array);
    assert.ok(body.byteLength <= webLimits.uploadChunkBytes);
    data.set(body, Number(piece[2]) * webLimits.uploadChunkBytes);
    return new Response(null, { status: 204 });
  }
  if (/\/uploads\/upload-\d+\/complete$/.test(endpoint))
    return json({ ok: true });
}

async function browserRead(t: TestContext, f: ReturnType<typeof fixture>) {
  const { bridge, tab } = await signedInBridge();
  t.after(() => bridge.dispose());
  const requests: Array<
    Pick<OfficialUiWireRequest, "method" | "path" | "responseTransfer">
  > = [];
  let lease: string | undefined;
  tab.routes.unshift(async (request) => {
    const endpoint = new URL(request.url, tab.env.origin).pathname;
    const uploaded = uploadResponse(f.uploads, endpoint, request.body);
    if (uploaded) return uploaded;
    const method = endpoint.slice(webPaths.rpc.length);
    if (
      !endpoint.startsWith(webPaths.rpc) ||
      (method !== "officialUiRead" && method !== "officialUiAction")
    )
      return undefined;
    const [input] = (request.body as { args: OfficialUiWireRequest[] }).args;
    requests.push({
      method: input.method,
      path: input.path,
      responseTransfer: input.responseTransfer,
    });
    const result = await f.run(input, 1, method);
    return result.ok
      ? json({ ok: true, value: result.value })
      : json({ ok: false, error: result.error });
  });
  const fetch = createOfficialReadFetch(
    tab.env.origin,
    bridge.officialUiRead,
    async () => {
      throw Error("The original file must come from the runner.");
    },
    bridge.officialUiEvents,
    (request) =>
      bridge.officialUiAction({ ...request, capabilityLease: lease }),
  );
  return {
    fetch,
    requests,
    async authorize() {
      const answer = await bridge.officialUiRead({
        method: "GET",
        path: officialUiCapabilitiesPath,
      });
      assert.equal(answer.status, 200);
      lease = JSON.parse(Buffer.from(answer.body).toString()).activationLease;
      assert.ok(lease);
    },
  };
}

function nativeCloud(
  f: ReturnType<typeof fixture>,
  hooks: {
    onRequest?(method: string, token: string | null): Response | undefined;
    onReply?(method: string): void;
  } = {},
) {
  let token = "fixture";
  let session: CloudSession | undefined = {
    currentToken: async () => token,
    renewed: async () => (token = "renewed"),
  };
  const methods: string[] = [];
  const client = new CloudClient({
    baseUrl: "https://claudex.example.com",
    session: () => session,
    randomId: () => "desktop-fixture",
    fetch: async (input, init) => {
      const endpoint = new URL(String(input)).pathname;
      const payload = init?.body;
      const authorization = new Headers(init?.headers).get("Authorization");
      if (endpoint.startsWith(webPaths.uploads)) {
        const intercepted = hooks.onRequest?.(endpoint, authorization);
        if (intercepted) return intercepted;
        const uploaded = uploadResponse(
          f.uploads,
          endpoint,
          typeof payload === "string" ? JSON.parse(payload) : payload,
        );
        assert.ok(uploaded);
        hooks.onReply?.(endpoint);
        return uploaded;
      }
      const method = endpoint.slice(webPaths.rpc.length);
      assert.ok(
        typeof payload === "string" &&
          Buffer.byteLength(payload) <= webLimits.rpcBodyBytes,
      );
      const body = parseRpcRequest(JSON.parse(payload));
      methods.push(method);
      const intercepted = hooks.onRequest?.(method, authorization);
      if (intercepted) return intercepted;
      const frame = await f.invoke(method, body.args);
      hooks.onReply?.(method);
      return frame.ok
        ? json({ ok: true, value: frame.value })
        : json({ ok: false, error: frame.error });
    },
  });
  return {
    methods,
    write: (file: { name: string; text: string; displayName?: string }) =>
      client.call("addProjectKnowledgeText", [f.projectId, file]),
    read: (name: string) =>
      client.call("readProjectKnowledge", [f.projectId, name]),
    signOut: () => (session = undefined),
    switchAccount: () =>
      (session = {
        currentToken: async () => "different-account",
        renewed: async () => "different-account",
      }),
  };
}

test("native cloud saves an exact 30 MiB text file once after refreshing its token", async (t) => {
  const f = fixture(t);
  const ending = "\n最后一行。\n";
  const content =
    "a".repeat(knowledgeFileLimit - Buffer.byteLength(ending)) + ending;
  let expired = 0;
  const desktop = nativeCloud(f, {
    onRequest: (endpoint, token) => {
      if (!endpoint.endsWith("/chunks/0")) return;
      if (token === "Bearer fixture") {
        expired++;
        return json({ code: 401 }, 401);
      }
      assert.equal(token, "Bearer renewed");
    },
  });
  await desktop.write({ name: "limit.txt", text: content });
  assert.equal(expired, 1);
  assert.deepEqual(f.contexts[0].calls, ["addProjectKnowledgeText"]);
  const stored = fs.readFileSync(path.join(f.knowledgeFolder, "limit.txt"));
  assert.equal(stored.length, knowledgeFileLimit);
  assert.ok(stored.toString("utf8") === content);
  await assert.rejects(
    desktop.write({ name: "over.txt", text: content + "a" }),
    {
      code: "CLAUDEX_WEB_TOO_LARGE",
    },
  );
  assert.equal(f.uploads.size, 1);
  assert.deepEqual(f.contexts[0].calls, ["addProjectKnowledgeText"]);
  assert.deepEqual(fs.readdirSync(f.knowledgeFolder), ["limit.txt"]);
});

test("native cloud saves the full extracted DOCX text with its original display name", async (t) => {
  const f = fixture(t);
  const name = "Long report.docx";
  const content = "Read this paragraph. ".repeat(60_000) + "Last paragraph.";
  const text = await extractKnowledgeDocument({
    data: await knowledgeDocx(content),
    name,
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    signal: new AbortController().signal,
  });
  assert.ok(
    text === content && Buffer.byteLength(text) > webLimits.rpcBodyBytes,
  );
  await nativeCloud(f).write({ name, text, displayName: name });
  assert.deepEqual(f.contexts[0].calls, ["addProjectKnowledgeText"]);
  const listed = await f.invoke("listProjectKnowledge", [f.projectId]);
  assert.equal(listed.ok, true, listed.error?.message);
  assert.ok(
    listed.value &&
      typeof listed.value === "object" &&
      "files" in listed.value &&
      Array.isArray(listed.value.files),
  );
  assert.deepEqual(
    listed.value.files.map(({ name, displayName, bytes }) => ({
      name,
      displayName,
      bytes,
    })),
    [
      {
        name: `${name}.md`,
        displayName: name,
        bytes: Buffer.byteLength(content),
      },
    ],
  );
  assert.ok(
    fs.readFileSync(path.join(f.knowledgeFolder, `${name}.md`), "utf8") ===
      content,
  );
});

test("native cloud account switch during staging does not dispatch a text write", async (t) => {
  const f = fixture(t);
  const desktop = nativeCloud(f, {
    onReply: (endpoint) => {
      if (endpoint.endsWith("/complete")) desktop.switchAccount();
    },
  });
  await assert.rejects(
    desktop.write({
      name: "old.txt",
      text: "a".repeat(webLimits.rpcBodyBytes),
    }),
    /account changed/,
  );
  assert.deepEqual(desktop.methods, []);
  assert.deepEqual(
    f.contexts.map((owner) => owner.calls),
    [[], []],
  );
});

test("runner does not write staged project text after cancellation or account activation changes", async (t) => {
  const f = fixture(t);
  const id = "staged-text";
  const args = [f.projectId, { name: "never.txt", text: { $upload: id } }];
  f.uploads.set(id, Buffer.from("Pending project text"));
  f.onUploadRead(() => f.dispatcher.cancel("cancelled-text"));
  await f.dispatcher.call({
    t: "call",
    id: "cancelled-text",
    method: "addProjectKnowledgeText",
    user: { id: 1, accessToken: "fixture" },
    args,
    deadlineMs: webLimits.callTimeoutMs,
  });
  assert.deepEqual(f.contexts[0].calls, []);
  f.onUploadRead(f.contexts[0].rotate);
  const changed = await f.invoke("addProjectKnowledgeText", args);
  assert.equal(changed.ok, false);
  assert.match(changed.error?.message ?? "", /account changed/);
  assert.deepEqual(f.contexts[0].calls, []);
});

test("plain text stays compatible with old clients, including large JSON escape overhead", async (t) => {
  const f = fixture(t);
  const old = await f.invoke("addProjectKnowledgeText", [
    f.projectId,
    { name: "old.txt", text: "Old client." },
  ]);
  assert.equal(old.ok, true, old.error?.message);
  const desktop = nativeCloud(f);
  await desktop.write({ name: "small.txt", text: "Small file." });
  assert.equal(f.uploads.size, 0);
  const text = '\\"\n'.repeat(webLimits.rpcBodyBytes / 6) + "Last line.";
  await desktop.write({ name: "escaped.txt", text });
  assert.ok(
    fs.readFileSync(path.join(f.knowledgeFolder, "escaped.txt"), "utf8") ===
      text,
  );
});

test("a 30 MiB scanned PDF arrives intact through the native cloud client after a token refresh", async (t) => {
  const f = fixture(t);
  const pdf = scannedPdf(knowledgeFileLimit);
  await f.addFiles([{ name: "large-scan.pdf", data: pdf }]);
  f.contexts[0].calls.length = 0;
  let expired = 0;
  const desktop = nativeCloud(f, {
    onRequest: (method, token) => {
      if (method !== "officialUiRead") return;
      if (token === "Bearer fixture") {
        expired++;
        return json({ code: 401 }, 401);
      }
      assert.equal(token, "Bearer renewed");
    },
  });
  const result = await desktop.read("large-scan.pdf");
  assert.ok(result && typeof result === "object" && "base64" in result);
  const { base64, ...metadata } = result;
  assert.deepEqual(metadata, {
    name: "large-scan.pdf",
    bytes: pdf.length,
    kind: "pdf",
  });
  assert.ok(
    typeof base64 === "string" && Buffer.from(base64, "base64").equals(pdf),
  );
  assert.equal(expired, 1);
  assert.equal(desktop.methods[0], "readProjectKnowledge");
  assert.ok(desktop.methods.length > 2);
  assert.ok(
    desktop.methods.slice(1).every((method) => method === "officialUiRead"),
  );
  assert.deepEqual(f.contexts[0].calls, ["readProjectKnowledge"]);
  const legacy = await f.invoke("readProjectKnowledge", [
    f.projectId,
    "large-scan.pdf",
  ]);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.error?.code, "CLAUDEX_WEB_TOO_LARGE");
});

test("public project reads preserve small text and PDFs and give old clients supported preview kinds", async (t) => {
  const f = fixture(t);
  const text = "a note\n";
  const pdf = scannedPdf(16 * 1024);
  const png = Buffer.from(imageSizeFixtures[0].base64, "base64");
  const utf16 = Buffer.concat([
    Buffer.of(0xff, 0xfe),
    Buffer.from(text, "utf16le"),
  ]);
  await f.addFiles([
    { name: "small.txt", data: Buffer.from(text) },
    { name: "small.pdf", data: pdf },
    { name: "small.png", data: png },
    { name: "wide.csv", data: utf16 },
  ]);
  const desktop = nativeCloud(f);
  const legacyRead = async (name: string) => {
    const frame = await f.invoke("readProjectKnowledge", [f.projectId, name]);
    assert.equal(frame.ok, true, frame.error?.message);
    return decodeWireValue(frame.value);
  };
  const note = { name: "small.txt", bytes: text.length, kind: "text", text };
  const document = {
    name: "small.pdf",
    bytes: pdf.length,
    kind: "pdf",
    base64: pdf.toString("base64"),
  };
  assert.deepEqual(await legacyRead("small.txt"), note);
  assert.deepEqual(await desktop.read("small.txt"), note);
  assert.deepEqual(await legacyRead("small.pdf"), document);
  assert.deepEqual(await desktop.read("small.pdf"), document);
  assert.deepEqual(await legacyRead("small.png"), {
    name: "small.png",
    bytes: png.length,
    kind: "unsupported",
    reason: "type",
  });
  assert.deepEqual(await desktop.read("small.png"), {
    name: "small.png",
    bytes: png.length,
    kind: "image",
    mime: "image/png",
    base64: png.toString("base64"),
  });
  assert.deepEqual(await legacyRead("wide.csv"), {
    name: "wide.csv",
    bytes: utf16.length,
    kind: "unsupported",
    reason: "encoding",
  });
  assert.ok(
    desktop.methods.every((method) => method === "readProjectKnowledge"),
  );
});

test("a runner without official Web serves ordinary project knowledge RPC replies", async (t) => {
  const f = fixture(t, false);
  const text = "a note\n";
  await f.addFiles([{ name: "small.txt", data: Buffer.from(text) }]);
  const args = [f.projectId, "small.txt", { responseTransfer: true }];
  const frame = await f.invoke("readProjectKnowledge", args);
  assert.equal(frame.ok, true, frame.error?.message);
  const expected = {
    name: "small.txt",
    bytes: text.length,
    kind: "text",
    text,
  };
  assert.deepEqual(decodeWireValue(frame.value), expected);
  assert.deepEqual(await nativeCloud(f).read("small.txt"), expected);
});

test("the native cloud client stops fetching project knowledge on sign-out or account switch", async (t) => {
  const f = fixture(t);
  await f.addFiles([{ name: "scan.pdf", data: scannedPdf(6 * 1024 * 1024) }]);
  const signedOut = nativeCloud(f, {
    onReply: () => signedOut.signOut(),
  });
  await assert.rejects(signedOut.read("scan.pdf"), /account changed/);
  assert.deepEqual(signedOut.methods, ["readProjectKnowledge"]);

  const switched = nativeCloud(f, {
    onReply: (method) => {
      if (method === "officialUiRead") switched.switchAccount();
    },
  });
  await assert.rejects(switched.read("scan.pdf"), /account changed/);
  assert.deepEqual(switched.methods, [
    "readProjectKnowledge",
    "officialUiRead",
  ]);
});

test("a 30 MiB scanned PDF arrives intact through preview and generic file GETs", async (t) => {
  const f = fixture(t);
  const pdf = scannedPdf(knowledgeFileLimit);
  const urls = await f.seed("large-scan.pdf", pdf);
  const { fetch, requests } = await browserRead(t, f);
  for (const url of Object.values(urls)) {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-length"), String(pdf.length));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(pdf));
  }
  assert.deepEqual(
    requests.filter(
      ({ path }) => !path.startsWith(officialResponseChunkPrefix),
    ),
    Object.values(urls).map((path) => ({
      method: "GET",
      path,
      responseTransfer: true,
    })),
  );
  assert.ok(requests.length > 2);
  assert.ok(
    requests
      .filter(({ path }) => path.startsWith(officialResponseChunkPrefix))
      .every(({ responseTransfer }) => responseTransfer === undefined),
  );
  assert.equal(
    f.contexts[0].calls.filter((name) => name === "readProjectKnowledge")
      .length,
    2,
  );
  assert.equal(
    f.contexts[0].calls.filter((name) => name === "addProjectKnowledgeFiles")
      .length,
    1,
  );
});

test("large DOCX extraction uses one conversion request and does not write project knowledge", async (t) => {
  const f = fixture(t);
  const { fetch, requests } = await browserRead(t, f);
  const name = "large.docx";
  const type =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const content = "Read this paragraph. ".repeat(220_000) + "Done.";
  assert.ok(Buffer.byteLength(content) > officialUiReadMaxBytes);
  const docx = await knowledgeDocx(content);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(docx)], { type }), name);
  const url = `/api/organizations/${organizationUuid("owner-1")}/convert_document`;
  const answer = await fetch(url, { method: "POST", body: form });
  assert.equal(answer.status, 200);
  const result = await answer.json();
  assert.equal(result.file_name, name);
  assert.equal(result.file_size, docx.length);
  assert.equal(result.file_type, type);
  assert.ok(result.extracted_content === content);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST"),
    [{ method: "POST", path: url, responseTransfer: true }],
  );
  assert.ok(requests.length > 1);
  assert.ok(
    requests
      .slice(1)
      .every(
        ({ method, path }) =>
          method === "GET" && path.startsWith(officialResponseChunkPrefix),
      ),
  );
  assert.deepEqual(f.contexts[0].calls, []);
});

test("a project text save reassembles its large gzip reply without repeating the write", async (t) => {
  const f = fixture(t);
  const { fetch, requests, authorize } = await browserRead(t, f);
  await authorize();
  const content = randomBytes(5 * 1024 * 1024).toString("base64");
  const body = JSON.stringify({ file_name: "Notes", content });
  assert.ok(gzipSync(body, { level: 1 }).length > officialUiReadMaxBytes);
  const url = `${f.base}/docs`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), null);
  const saved = await response.json();
  assert.ok(saved.content === content);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST"),
    [{ method: "POST", path: url, responseTransfer: true }],
  );
  assert.ok(
    requests.some(({ path }) => path.startsWith(officialResponseChunkPrefix)),
  );
  const read = await fetch(`${url}/${saved.uuid}`);
  assert.equal(read.status, 200);
  assert.ok((await read.json()).content === content);
  assert.equal(
    f.contexts[0].calls.filter((method) => method === "addProjectKnowledgeText")
      .length,
    1,
  );
  assert.equal(
    f.contexts[0].calls.filter((method) => method === "readProjectKnowledge")
      .length,
    2,
  );
});

test("an oversized gzip file needs transfer support and preserves its download headers", async (t) => {
  const f = fixture(t);
  const archive = await new JSZip()
    .file("raw.bin", randomBytes(5 * 1024 * 1024))
    .file("zeros.bin", Buffer.alloc(2 * 1024 * 1024))
    .generateAsync({ type: "nodebuffer" });
  const compressedBytes = gzipSync(archive, { level: 1 }).length;
  assert.ok(
    compressedBytes > officialUiReadMaxBytes &&
      compressedBytes < archive.length,
  );
  const { contents } = await f.seed("archive.zip", archive);
  const legacy = await f.read({
    method: "GET",
    path: contents,
    acceptEncoding: "gzip",
  });
  assert.equal(legacy.status, 413);
  assert.equal(legacy.responseTransfer, undefined);
  assert.equal(legacy.bodyEncoding, undefined);
  assert.equal(legacy.contentType, "application/json");
  assert.deepEqual(JSON.parse(Buffer.from(legacy.body).toString()), {
    error: "The official Web response is too large.",
  });
  const { fetch, requests } = await browserRead(t, f);
  const response = await fetch(contents);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(
    response.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /attachment;.*archive\.zip/,
  );
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(archive));
  assert.ok(
    requests.some(({ path }) => path.startsWith(officialResponseChunkPrefix)),
  );
});

test("Code history reads large input images, MCP results, and generated files", async (t) => {
  const f = fixture(t, true, ["code"]);
  const { ctx } = f.contexts[0];
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(content));
    return Buffer.concat([length, content, checksum]);
  };
  const png = (side: number) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side);
    header.writeUInt32BE(side, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc((side * 3 + 1) * side), { level: 0 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  const image = png(1040);
  const toolImage = png(1023).toString("base64");
  const toolSummary = "Tile is uniformly black.\n".repeat(1000);
  assert.ok(image.toString("base64").length > officialUiReadMaxBytes);
  assert.ok(toolImage.length <= officialUiReadMaxBytes);
  assert.ok(toolImage.length + toolSummary.length > officialUiReadMaxBytes);
  const attachment = storeAttachment(path.join(ctx.store.root, "attachments"), "large.png", image, openPolicy);
  const cwd = path.join(ctx.store.root, "workspace");
  fs.mkdirSync(cwd);
  const pdf = scannedPdf(5 * 1024 * 1024);
  fs.writeFileSync(path.join(cwd, "result.pdf"), pdf);
  const blobs = new GeneratedBlobs(ctx.store.root);
  const generatedFiles = captureOutputFiles(cwd, 0, new Set(), blobs);
  assert.equal(generatedFiles.length, 1);
  const conversation: Conversation = {
    id: "code-with-large-image",
    mode: "code",
    title: "Image history",
    model: "fixture",
    providerId: "fixture",
    cwd,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [{
      id: "turn",
      prompt: "Describe the attached image.",
      createdAt: 1,
      attachments: [attachment],
      status: "completed",
      items: [
        { id: "answer", type: "agentMessage", text: "Black square." },
        { id: "steer", type: "userMessage", steered: true, clientId: "steer-image", text: "Inspect the same image again.", attachments: [attachment] },
        {
          id: "image-tool",
          type: "mcpToolCall",
          status: "completed",
          server: "image-tool",
          tool: "inspect",
          result: { content: [
            { type: "image", mimeType: "image/png", data: toolImage },
            { type: "text", text: toolSummary },
          ] },
        },
        { id: "outputs", type: "outputFiles", status: "completed", generatedFiles },
      ],
    }],
  };
  ctx.store.conversations = [conversation];
  ctx.handlers.set("snapshot", () => ({ conversations: [conversation] }));
  ctx.handlers.set("conversationTurns", () => ({ turns: conversation.turns }));
  ctx.handlers.set("turnAttachment", (id, attachmentId) => {
    assert.ok(typeof id === "string" && typeof attachmentId === "string");
    const owned = readOwnedTurnAttachment(ctx.store, id, attachmentId);
    return owned && { name: owned.attachment.name, data: owned.data };
  });
  ctx.handlers.set("readGeneratedFile", (digest) => {
    assert.ok(typeof digest === "string");
    return blobs.read(digest).toString("base64");
  });

  const { fetch, requests } = await browserRead(t, f);
  const sessions = await (await fetch("/v1/code/sessions")).json();
  const events = `/v1/code/sessions/${sessions.data[0].id}/events`;
  const first = await fetch(events + "?sort_order=asc");
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.deepEqual(page.data.map((row: { sequence_num: number }) => row.sequence_num), [1, 2, 3, 4]);
  assert.equal(page.resume_cursor, "4");
  assert.equal(page.data[0].payload.message.content, "Describe the attached image.");
  const imageRef = { file_uuid: attachment.id, file_name: "large.png", is_image: true };
  assert.deepEqual(page.data[0].payload.file_attachments, [imageRef]);
  assert.deepEqual(page.data[2].payload.file_attachments, [imageRef]);
  const files = `/api/organizations/${organizationUuid("owner-1")}/files`;
  const inputImage = await fetch(`${files}/${imageRef.file_uuid}/contents`);
  assert.equal(inputImage.status, 200);
  assert.equal(inputImage.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await inputImage.arrayBuffer()).equals(image));
  const tool = await fetch(events + "?sort_order=asc&cursor=" + page.next_cursor);
  assert.equal(tool.status, 200);
  const toolPage = await tool.json();
  assert.equal(toolPage.data.length, 1);
  assert.equal(toolPage.data[0].sequence_num, 5);
  const blocks = toolPage.data[0].payload.message.content[0].content;
  assert.ok(blocks[0].source.data === toolImage);
  assert.equal(blocks[1].text, toolSummary);
  const next = await fetch(events + "?sort_order=asc&cursor=" + toolPage.next_cursor);
  assert.equal(next.status, 200);
  const nextPage = await next.json();
  assert.deepEqual(nextPage.data.map((row: { sequence_num: number }) => row.sequence_num), [6, 7, 8]);
  assert.equal(nextPage.next_cursor, null);
  const result = nextPage.data[1].payload.tool_use_result.attachments[0];
  assert.equal(result.path, "result.pdf");
  assert.equal(result.size, pdf.length);
  assert.ok(result.file_uuid);
  const contents = `${files}/${result.file_uuid}/contents`;
  const download = await fetch(contents);
  assert.equal(download.status, 200);
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(pdf));

  const replay = await fetch(events + "/stream");
  assert.equal(replay.status, 200);
  const reader = replay.body!.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  const initialFrame = decoder.decode((await reader.read()).value);
  assert.match(initialFrame, /id: 1\nevent: client_event/);
  assert.match(initialFrame, /Black square/);
  const followingFrame = decoder.decode((await reader.read()).value);
  assert.match(followingFrame, /id: 5\nevent: client_event/);
  assert.ok(followingFrame.includes(toolImage));
  const finalFrame = decoder.decode((await reader.read()).value);
  assert.match(finalFrame, /id: 8\nevent: client_event/);
  assert.ok(requests.some(({ path }) => path.startsWith(officialResponseChunkPrefix)));
});

test("original Web Code Files reads the owned workspace over its Code stream", async (t) => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", {
    value: hostPlatform,
    configurable: true,
  });
  t.after(() =>
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    }),
  );
  const f = fixture(t, true, ["chat", "code"]);
  const { ctx } = f.contexts[0];
  const owner = ctx.activeAccount.id;
  const spaceId = "files-space";
  const spaceRoot = (id: string) => path.join(ctx.store.root, "spaces", id);
  const cwd = path.join(
    spaceRoot(spaceId),
    "workspace",
    "code",
    "saved-session",
  );
  const name = "设计/说明.md";
  const content = "# 项目\n" + "文件正文\n".repeat(1000);
  const media = Buffer.alloc(3 * 1024 * 1024, 0xff);
  fs.mkdirSync(path.join(cwd, "设计"), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  fs.writeFileSync(path.join(cwd, "recording.wav"), media);
  const privateFile = path.join(ctx.store.root, "private.md");
  fs.writeFileSync(privateFile, "outside this session");
  fs.symlinkSync(privateFile, path.join(cwd, "outside.md"));
  Object.assign(ctx, { spaceRoot });
  const conversation: Conversation = {
    id: "saved-session",
    mode: "code",
    model: "fixture",
    providerId: "fixture",
    title: "Saved Code session",
    cwd,
    environment: { kind: "space", spaceId },
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    turns: [],
  };
  ctx.store.conversations = [conversation];
  ctx.handlers.set("snapshot", () => ({ conversations: [conversation] }));
  ctx.handlers.set("conversationTurns", () => ({ turns: [] }));
  const { fetch, requests, authorize } = await browserRead(t, f);
  await authorize();
  const key = cloudCodeSessionKey(conversation, owner);
  const session = `/v1/code/sessions/session_${key}`;
  const events = session + "/events";
  const organization = organizationUuid(owner);
  const headers = { "x-organization-uuid": organization };
  const details = await fetch(session, { headers });
  assert.equal((await details.json()).session.session_context.cwd, cwd);
  const stream = await fetch(events + "/stream", { headers });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  let sequence = 0;
  const payload = (request: { subtype: string } & Record<string, unknown>) => ({
    type: "control_request",
    request_id: `${request.subtype}-fixture-${++sequence}`,
    request,
  });
  async function control(
    request: Parameters<typeof payload>[0],
    legacy = false,
  ) {
    const event = payload(request);
    const reply = await fetch(
      legacy ? `/v1/sessions/session_${key}/events` : events,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          events: legacy ? [event] : [{ payload: event }],
        }),
      },
    );
    assert.equal(reply.status, 200, await reply.clone().text());
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.doesNotMatch(frame, /^id:/m);
    const data = /^data: (.+)$/m.exec(frame);
    assert.ok(data);
    const result = JSON.parse(data[1]).payload.response;
    assert.equal(result.request_id, event.request_id);
    return result;
  }
  assert.deepEqual(
    (await control({ subtype: "list_directory", path: "" })).response,
    {
      entries: [
        { name: "outside.md", isDirectory: false, isSymlink: true },
        { name: "recording.wav", isDirectory: false, isSymlink: false },
        { name: "设计", isDirectory: true, isSymlink: false },
      ],
      truncated: false,
      absPath: cwd,
    },
  );
  assert.deepEqual(
    (await control({ subtype: "list_directory", path: "设计" }, true)).response
      .entries,
    [{ name: "说明.md", isDirectory: false, isSymlink: false }],
  );
  assert.deepEqual(
    (await control({ subtype: "file_suggestions", query: "说明" })).response,
    {
      cwd,
      suggestions: [{ path: name }],
    },
  );
  assert.deepEqual(
    (await control({ subtype: "file_suggestions", query: "not-found" }))
      .response.suggestions,
    [],
  );
  assert.deepEqual(
    (await control({ subtype: "read_file", path: path.join(cwd, name) }))
      .response,
    {
      contents: content,
      encoding: "utf8",
      fileSize: Buffer.byteLength(content),
      truncated: false,
      absPath: path.join(cwd, name),
    },
  );
  const anchored = await control({
    subtype: "read_file",
    path: name,
    anchor: { kind: "as_written", within: [cwd] },
  });
  assert.equal(anchored.response.anchor, "as_written");
  assert.equal(anchored.response.absPath, path.join(cwd, name));
  assert.equal(anchored.response.contents, content);
  const bytes = await control({
    subtype: "read_file",
    path: "recording.wav",
    encoding: "base64",
    max_bytes: media.length,
  });
  assert.deepEqual(Buffer.from(bytes.response.contents, "base64"), media);
  assert.ok(
    requests.some(({ path }) => path.startsWith(officialResponseChunkPrefix)),
  );
  for (const file of [privateFile, "outside.md", "../private.md"])
    assert.equal(
      (await control({ subtype: "read_file", path: file })).error,
      "read denied: outside_workspace",
    );
  assert.equal(
    (await control({ subtype: "read_file", path: "missing" })).error,
    "ENOENT",
  );
  fs.writeFileSync(path.join(cwd, "设计", "新增.txt"), "new file");
  assert.ok(
    (
      await control({ subtype: "list_directory", path: "设计" })
    ).response.entries.some(
      (entry: { name: string }) => entry.name === "新增.txt",
    ),
  );

  const foreign = f.contexts[1].ctx.activeAccount.id;
  const foreignCapability = await f.read(
    { method: "GET", path: officialUiCapabilitiesPath },
    2,
  );
  const foreignLease = JSON.parse(
    Buffer.from(foreignCapability.body).toString(),
  ).activationLease;
  const denied = await f.run(
    {
      method: "POST",
      path: events,
      codeOrganizationId: organizationUuid(foreign),
      contentType: "application/json",
      capabilityLease: foreignLease,
      body: Buffer.from(
        JSON.stringify({
          events: [
            { payload: payload({ subtype: "list_directory", path: "" }) },
          ],
        }),
      ),
    },
    2,
    "officialUiAction",
  );
  assert.equal(denied.ok, true, denied.error?.message);
  assert.equal(
    (decodeWireValue(denied.value) as OfficialUiWireResponse).status,
    404,
  );
});

test("original Web Changes reads the saved space and transfers large patches over its Code stream", async (t) => {
  const f = fixture(t, true, ["chat", "code"]);
  const { ctx } = f.contexts[0];
  const owner = ctx.activeAccount.id;
  const spaceId = "repo-space";
  const spaceRoot = (id: string) => path.join(ctx.store.root, "spaces", id);
  const cwd = path.join(
    spaceRoot(spaceId),
    "workspace",
    "code",
    "saved-session",
  );
  fs.mkdirSync(cwd, { recursive: true });
  const write = (name: string, content: string | Buffer) =>
    fs.writeFileSync(path.join(cwd, name), content);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  Object.assign(ctx, {
    spaceRoot,
    runtime: {
      workingTree(input: {
        userId: number;
        storeRoot: string;
        spaceId: string;
      }) {
        assert.deepEqual(input, {
          userId: 1,
          storeRoot: spaceRoot(spaceId),
          spaceId,
        });
        return localWorkingTree;
      },
    },
  });
  const conversation: Conversation = {
    id: "saved-session",
    mode: "code",
    model: "fixture",
    providerId: "fixture",
    title: "Saved Code session",
    cwd,
    environment: { kind: "space", spaceId },
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    turns: [],
  };
  ctx.store.conversations = [conversation];
  ctx.handlers.set("snapshot", () => ({ conversations: [conversation] }));
  ctx.handlers.set("conversationTurns", () => ({ turns: [] }));

  const { fetch, requests, authorize } = await browserRead(t, f);
  await authorize();
  const key = cloudCodeSessionKey(conversation, owner);
  const events = `/v1/code/sessions/session_${key}/events`;
  const org = organizationUuid(owner);
  const stream = await fetch(events + "/stream", {
    headers: { "x-organization-uuid": org },
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  const payload = {
    type: "control_request",
    request_id: "get_workspace_diff-123-fixture",
    request: { subtype: "get_workspace_diff" },
  };
  const submit = (pathname: string, body: unknown, organization = org) =>
    fetch(pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-organization-uuid": organization,
      },
      body: JSON.stringify(body),
    });
  const wrapped = { events: [{ payload }] };
  const legacy = `/v1/sessions/session_${key}/events`;
  assert.equal(
    (await submit(events, wrapped, organizationUuid("another-owner"))).status,
    404,
  );
  assert.equal(
    (await submit(events.replace(key, "f".repeat(32)), wrapped)).status,
    404,
  );
  assert.equal(
    (
      await submit(events, {
        events: [
          { payload: { ...payload, request: { ...payload.request, cwd } } },
        ],
      })
    ).status,
    400,
  );
  const diff = async (pathname: string, body: unknown) => {
    const response = await submit(pathname, body);
    assert.equal(response.status, 200, await response.clone().text());
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.doesNotMatch(frame, /^id:/m);
    const json = /^data: (.+)$/m.exec(frame);
    assert.ok(json);
    const reply = JSON.parse(json[1]).payload.response;
    assert.equal(reply.request_id, payload.request_id);
    return reply.response.diff;
  };
  assert.equal(await diff(legacy, { events: [payload] }), null);

  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  write("staged.txt", "before stage\n");
  write("tracked.txt", "before working\n");
  write("rename source.txt", "rename content\n");
  write("keep local.txt", "leave this in the working directory\n");
  git("add", ".");
  git("commit", "-qm", "Baseline");
  assert.deepEqual((await diff(events, wrapped)).stats, {
    filesCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
  });
  git("checkout", "-qb", "feature");
  write("committed.txt", "branch addition\n");
  git("add", "committed.txt");
  git("commit", "-qm", "Branch work");
  git("mv", "rename source.txt", "rename destination.txt");
  git("rm", "--cached", "keep local.txt");
  write("staged.txt", "after stage\n");
  git("add", "staged.txt");
  write("tracked.txt", "after working\n");
  write("untracked.txt", "new in working tree\n");
  write("binary.dat", Buffer.from([0, 12, 13]));
  write("many-lines.txt", "extra line\n".repeat(801));
  const wideLine = "z".repeat(48_000);
  write("wide.txt", (wideLine + "\n").repeat(100));
  git("add", "wide.txt");

  const change = await diff(events, wrapped);
  assert.equal(change.source.kind, "branch");
  assert.equal(change.source.baseBranch, "main");
  assert.deepEqual(change.stats, {
    filesCount: 9,
    linesAdded: 905,
    linesRemoved: 3,
  });
  const metadata = Object.fromEntries(
    change.perFileStats.map((row: { path: string }) => [row.path, row]),
  );
  assert.deepEqual(metadata["rename destination.txt"], {
    path: "rename destination.txt",
    previousPath: "rename source.txt",
    status: "renamed",
    added: 0,
    removed: 0,
    isBinary: false,
    isUntracked: false,
  });
  assert.equal(metadata["binary.dat"].isBinary, true);
  assert.equal(metadata["keep local.txt"].status, "removed");
  assert.equal(metadata["untracked.txt"].isUntracked, true);
  assert.deepEqual(change.skippedLarge, ["many-lines.txt"]);
  const hunks = Object.fromEntries(
    change.hunks.map((row: { path: string; hunks: unknown }) => [
      row.path,
      row.hunks,
    ]),
  );
  assert.deepEqual(hunks["tracked.txt"], [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-before working", "+after working"],
    },
  ]);
  assert.deepEqual(hunks["untracked.txt"][0].lines, ["+new in working tree"]);
  assert.equal(hunks["wide.txt"][0].lines[99], "+" + wideLine);
  assert.ok(
    requests.some(({ path }) => path.startsWith(officialResponseChunkPrefix)),
  );
});

test("response chunks are ordered, retriable, and confined to the current context", async (t) => {
  const f = fixture(t);
  const pdf = scannedPdf(5_042_235);
  assert.ok(gzipSync(pdf, { level: 1 }).length > officialUiReadMaxBytes);
  const { preview } = await f.seed("scan.pdf", pdf);
  const read = () =>
    f.read({ method: "GET", path: preview, responseTransfer: true });
  const initial = await read();
  assert.equal(initial.status, 200);
  assert.equal(initial.responseTransfer?.totalBytes, pdf.length);
  assert.ok(initial.responseTransfer);
  const pathAt = (offset: number) =>
    officialResponseChunkPath(initial.responseTransfer!.id, offset);
  const get = (offset: number, user?: number) =>
    f.read({ method: "GET", path: pathAt(offset) }, user);
  const size = officialResponseChunkBytes;
  const url = new URL(pathAt(size), "http://fixture");
  assert.equal(isOfficialUiQuery("GET", url.pathname, url.search), true);
  assert.equal(isOfficialUiQuery("POST", url.pathname, url.search), false);
  assert.equal(
    isOfficialUiQuery("GET", url.pathname, `${url.search}&offset=${size}`),
    false,
  );
  assert.equal((await get(size, 2)).status, 404);
  assert.equal((await get(size + 1)).status, 416);
  assert.equal((await get(size * 2)).status, 416);
  assert.equal(
    (await f.read({ method: "GET", path: `${pathAt(size)}&offset=${size}` }))
      .status,
    400,
  );
  const second = await get(size);
  assert.equal(second.responseOffset, size);
  assert.ok(Buffer.from(second.body).equals(pdf.subarray(size, size * 2)));
  const final = await get(size * 2);
  assert.equal(final.responseOffset, size * 2);
  assert.ok(Buffer.from(final.body).equals(pdf.subarray(size * 2)));
  assert.deepEqual(await get(size * 2), final);
  f.advance(30_001);
  assert.equal((await get(size * 2)).status, 404);
  const pending = await read();
  assert.ok(pending.responseTransfer);
  const path = officialResponseChunkPath(pending.responseTransfer.id, size);
  f.advance(5 * 60_000 + 1);
  assert.equal((await f.read({ method: "GET", path })).status, 404);
  const signedOut = await read();
  assert.ok(signedOut.responseTransfer);
  const oldPath = officialResponseChunkPath(
    signedOut.responseTransfer.id,
    size,
  );
  f.contexts[0].ctx.signedOut = true;
  assert.equal((await f.run({ method: "GET", path: oldPath })).ok, false);
  f.contexts[0].ctx.signedOut = false;
  f.contexts[0].rotate();
  assert.equal((await f.read({ method: "GET", path: oldPath })).status, 404);
});
