import { randomBytes } from "node:crypto";
/** Original history preview consumers -> read-fetch -> officialUiRead -> real
 * dispatcher session guards -> registered composer handler -> reopened Store.
 * Only self-created temporary attachments; no live accounts, UI or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { useElectronShim } from "./runner-core-support.test";
import { knowledgeDocx } from "../support/knowledge-document-fixtures";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { collectOfficialResponse } from "../../shared/web-client/official-response";
import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  isOfficialUiLargeResponse,
  isOfficialUiQuery,
  officialUiReadMaxBytes,
  type OfficialUiWireRequest,
} from "../../shared/official-ui-web";

useElectronShim();
const { officialUiRead } = await import("../../runner/src/official-ui-read");
const { run, newSession } =
  await import("../../runner/src/dispatcher-sessions");
const { registerComposerHandlers } =
  await import("../../electron/ipc/composer");
const conversationId = "11111111-1111-4111-8111-111111111111";
const owner = "synthetic-preview-owner";
const org = organizationUuid(owner);
const text = "Owned historical attachment\r\n原始内容 🦊\n";
const longBase = `/api/organizations/${org}/files`;
const shortBase = `/api/${org}/files`;
const historyPath = `/api/organizations/${org}/chat_conversations/${conversationId}`;

function fixture(
  t: TestContext,
  options: { name?: string; data?: Buffer; id?: string } = {},
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "web-owned-history-preview-"),
  );
  t.after(async () => {
    // The existing account-scoped metadata writer has a 500 ms debounce.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let identity: unknown = {},
    current: any,
    before: ((method: string) => void | Promise<void>) | undefined;
  let after: ((method: string) => void | Promise<void>) | undefined;
  const calls: { method: string; args: unknown[] }[] = [],
    logs: string[] = [],
    requests: string[] = [];
  const ctx: any = {
    userId: 7,
    activeAccount: {
      id: owner,
      name: "Synthetic",
      email: "synthetic@example.invalid",
    },
    signedOut: false,
    closedFlag: false,
    officialSessionIdentity: () => identity,
    store: new Store(root),
    replyFeedback: new ReplyFeedback(root),
    selectedAttachments: new Map(),
    handlers: new Map(),
    policy: () => openPolicy,
    setAccessToken() {},
    onEvent: () => () => {},
    push() {},
    appVersion: "test",
    log: (value: string) => logs.push(value),
  };
  current = ctx;
  registerComposerHandlers(
    (name, handler) => ctx.handlers.set(name, handler),
    ctx,
  );
  const attachment = ctx.handlers.get("addAttachmentData")(
    options.name ?? "original.txt",
    options.data ?? Buffer.from(text),
  );
  if (options.id) attachment.id = options.id;
  ctx.store.conversations = [
    {
      id: conversationId,
      title: "Synthetic history only",
      mode: "chat",
      providerId: "inert",
      model: "inert",
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          createdAt: 1,
          status: "completed",
          prompt: "Stored inert fixture",
          items: [],
          attachments: [attachment],
        },
      ],
    },
  ];
  ctx.store.flush();
  ctx.store = new Store(root);
  ctx.handlers.set("snapshot", () => ({
    conversations: ctx.store.conversations,
    projects: [],
  }));
  ctx.handlers.set("conversationTurns", (id: string) =>
    ctx.store.conversation(id),
  );
  const dispatcher: any = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: false,
    },
    guard: { modes: ["chat"] },
    methods: ["snapshot", "conversationTurns", "turnAttachment"],
    context: () => current,
    contextFor: async () => ctx,
    now: () => 0,
    newSession: (...args: any[]) =>
      (newSession as any).call(dispatcher, ...args),
    run: async (frame: any, expected: any) => {
      calls.push({
        method: frame.method,
        args: decodeWireValue(frame.args) as unknown[],
      });
      assert.equal(expected.context, ctx);
      await before?.(frame.method);
      const result = await run.call(dispatcher, frame, expected);
      await after?.(frame.method);
      return result;
    },
  };
  const read = (
    request: OfficialUiWireRequest,
    userId = 7,
    method = "officialUiRead",
  ) =>
    officialUiRead(dispatcher, {
      t: "call",
      id: "inert-preview",
      method,
      args: encodeWireValue([request]),
      user: { id: userId, accessToken: "inert-not-a-credential" },
    } as never) as Promise<any>;
  const fetch = createOfficialReadFetch(
    "https://synthetic.example.invalid",
    async (request) => {
      requests.push(request.path);
      const activation = identity;
      const allowTransfer = isOfficialUiLargeResponse(request.method, request.path.split("?")[0]);
      return collectOfficialResponse({
        initial: await read(allowTransfer ? { ...request, responseTransfer: true } : request),
        allowTransfer,
        isCurrent: () => identity === activation,
        readChunk: (path) => read({ method: "GET", path }),
      });
    },
    async () => {
      throw Error(
        "The original file consumer must not use network/native fetch.",
      );
    },
  );
  return {
    root,
    ctx,
    dispatcher,
    calls,
    logs,
    requests,
    read,
    fetch,
    attachment,
    before(fn: typeof before) {
      before = fn;
    },
    after(fn: typeof after) {
      after = fn;
    },
    retire(kind = "activation") {
      if (kind === "owner")
        ctx.activeAccount = { ...ctx.activeAccount, id: "another-owner" };
      else if (kind === "closed") ctx.closedFlag = true;
      else if (kind === "signedOut") ctx.signedOut = true;
      else if (kind === "context") current = {};
      else identity = {};
    },
    async history() {
      const response = await fetch(historyPath);
      assert.equal(response.status, 200);
      const value = await response.json();
      const file = value.chat_messages.find(
        (message: any) => message.sender === "human",
      ).files_v2[0];
      assert.equal(file.file_uuid, attachment.id);
      assert.ok(!JSON.stringify(value).includes(root));
      return file;
    },
  };
}

function functionSource(file: string, start: string, end: string) {
  const source = fs.readFileSync(
    `build/official-ui/ui/assets/v1/${file}`,
    "utf8",
  );
  const from = source.indexOf(start),
    to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Pinned original consumer ${start} exists`);
  return source.slice(from, to);
}

/** Unchanged recovered blob-preview URL selection and text-query consumers.
 * Only memo/hooks/query transport are harnessed; all status/bytes come from
 * the real authenticated Web/native route, never a supplied successful reply. */
function originalTextPreview(fetch: typeof globalThis.fetch, file: any) {
  const shared = "shared-m-w-0-Dp3k4Hda.js",
    preview = "shared-5-DQLFfFYX.js";
  const source = [
    functionSource(shared, "function r$(e, t) {", "\nfunction JL("),
    functionSource(preview, "function ZZ(e) {", "\nfunction pJ("),
    functionSource(preview, "function IC(e, t) {", "\nvar Kd ="),
  ].join("\n");
  assert.match(source, /responseType: "text"/);
  const memo = (...args: unknown[]) => args.at(-1),
    value = (...args: unknown[]) => args[2];
  const context: Record<string, unknown> = {
    file,
    fetch,
    J9: () => [],
    Tm: () => conversationId,
    ys: () => ({ activeOrganization: { uuid: org } }),
    aX: () => false,
    Zt: () => [
      null,
      () => {
        throw Error("Unexpected preview fallback");
      },
    ],
    fA: () => false,
    kC: () => {
      throw Error("No filesystem fallback");
    },
    Xz: (url: string, options: any) => ({
      data: options.enabled
        ? fetch(url).then(async (response) => {
            assert.equal(response.status, 200, `Original preview fetch ${url}`);
            return response.text();
          })
        : undefined,
      isError: false,
      isLoading: false,
    }),
  };
  for (let n = 0; n <= 5; n++) {
    context[`J${n}`] = () => true;
    context[`K${n}`] = memo;
    context[`I${n}`] = value;
    context[`Z${n}`] = value;
  }
  return vm.runInNewContext(
    `${source}\nIC(ZZ({fileUuid:file.file_uuid,downloadSource:file.download_source,conversationUuid:${JSON.stringify(conversationId)}}),{enabled:true})`,
    context,
  ) as { data: Promise<string>; url: string };
}

function originalUrl(name: "r$" | "JL" | "NV" | "zS", id: string) {
  const next = { r$: "JL", JL: "NV", NV: "zS", zS: "var EX" }[name];
  const source = functionSource(
    "shared-m-w-0-Dp3k4Hda.js",
    `function ${name}(e, t) {`,
    next === "var EX" ? "\nvar EX" : `\nfunction ${next}(`,
  );
  return vm.runInNewContext(`(${source})`, {
    ba: (value: string) => /^[a-f0-9-]{36}$/i.test(value),
  })(org, id) as string;
}

test("original blob preview reads the exact reopened historical file through the authenticated Web boundary", async (t) => {
  const f = fixture(t),
    file = await f.history();
  const original = originalTextPreview(f.fetch, file);
  assert.equal(await original.data, text);
  assert.equal(original.url, `${longBase}/${f.attachment.id}/contents`);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["turnAttachment"],
  );
  assert.deepEqual(f.calls.at(-1)?.args, [conversationId, f.attachment.id]);
  assert.equal(
    (await f.fetch(original.url)).headers.get("cache-control"),
    "no-store",
  );
});

test("original content-preview and short image URLs reach owned bytes and preserve media types", async (t) => {
  const f = fixture(t),
    file = await f.history();
  const preview = await f.fetch(originalUrl("JL", file.file_uuid));
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { content: text });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRhsAAAAASUVORK5CYII=",
    "base64",
  );
  const image = fixture(t, { name: "synthetic.png", data: png }),
    imageFile = await image.history();
  for (const name of ["NV", "zS"] as const) {
    const url = originalUrl(name, imageFile.file_uuid);
    assert.equal(
      url,
      imageFile[name === "NV" ? "preview_asset" : "thumbnail_asset"].url,
    );
    const response = await image.fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  }
});

test("original image download advertises its filename while previews stay inline", async (t) => {
  const data = Buffer.from("GIF89a synthetic attachment");
  const f = fixture(t, { name: "original 动画.gif", data });
  const file = await f.history();
  for (const url of [
    originalUrl("r$", file.file_uuid),
    `${shortBase}/${file.file_uuid}/contents`,
  ]) {
    const response = await f.fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/gif");
    assert.equal(
      response.headers.get("content-disposition"),
      "attachment; filename=\"attachment\"; filename*=UTF-8''original%20%E5%8A%A8%E7%94%BB.gif",
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  }
  for (const url of [file.preview_asset.url, file.thumbnail_asset.url]) {
    const response = await f.fetch(url);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.headers.get("content-type"), "image/gif");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  }
});

test("REST document and timeline-style short contents resolve the same exact owned file", async (t) => {
  const data = Buffer.from(
    "%PDF-1.7\n% Self-created inert PDF fixture\n%%EOF\n",
  );
  const f = fixture(t, { name: "synthetic.pdf", data }),
    file = await f.history();
  assert.equal(file.file_kind, "blob");
  assert.equal(file.file_name, "synthetic.pdf");
  assert.equal(file.path, "/synthetic.pdf");
  assert.equal(file.download_source, "files-api");
  assert.equal(file.size_bytes, data.length);
  assert.notEqual(file.text_extracted, true);
  const eligible = vm.runInNewContext(
    `(${functionSource("shared-m-8-CVxtIISM.js", "function tG(e) {", "\nfunction Ao(")})`,
    { IM: { SanitizedDocument: "document", Blob: "blob" } },
  );
  assert.equal(eligible(file), true);
  const previewUrl = `${shortBase}/${file.file_uuid}/preview`;
  for (const url of [previewUrl, originalUrl("r$", file.file_uuid)]) {
    const response = await f.fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), url === previewUrl ? null : `attachment; filename="attachment"; filename*=UTF-8''synthetic.pdf`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  }
});

test("safe non-UUID history IDs retain their native 500-character bound and exact identity", async (t) => {
  for (const id of ["imported_attachment-17", "a".repeat(500)]) {
    const f = fixture(t, { id }),
      file = await f.history();
    assert.equal(await originalTextPreview(f.fetch, file).data, text);
    assert.deepEqual(f.calls.at(-1)?.args, [conversationId, id]);
  }
});

test("unlearned, unknown and foreign-account files never reach attachment storage", async (t) => {
  const f = fixture(t),
    url = `${longBase}/${f.attachment.id}/contents`;
  assert.equal((await f.fetch(url)).status, 404);
  await f.history();
  f.calls.length = 0;
  for (const candidate of [
    `${longBase}/unknown-owned-id/contents`,
    url.replace(org, organizationUuid("foreign-owner")),
    `${shortBase}/${f.attachment.id}/contents`.replace(
      org,
      organizationUuid("foreign-owner"),
    ),
  ]) {
    const response = await f.fetch(candidate);
    assert.ok([403, 404].includes(response.status));
    assert.ok(!(await response.text()).includes(text));
  }
  assert.deepEqual(f.calls, []);
});

test("missing files and unowned paths including symlinks remain unreadable after learning history", async (t) => {
  for (const variant of ["missing", "outside", "symlink", "removed-row"]) {
    const f = fixture(t);
    await f.history();
    const row =
      f.ctx.store.conversation(conversationId).turns[0].attachments[0];
    const outside = path.join(f.root, "outside-owned-store.txt");
    fs.writeFileSync(outside, "OUTSIDE-PRIVATE-MARKER");
    if (variant === "missing") fs.unlinkSync(row.path);
    if (variant === "outside") row.path = outside;
    if (variant === "symlink") {
      fs.unlinkSync(row.path);
      fs.symlinkSync(outside, row.path);
    }
    if (variant === "removed-row")
      f.ctx.store.conversation(conversationId).turns[0].attachments = [];
    const response = await f.fetch(`${longBase}/${f.attachment.id}/contents`);
    assert.equal(response.status, 404, variant);
    const error = await response.text();
    assert.ok(!error.includes(text));
    assert.ok(!error.includes(f.root));
    assert.ok(!error.includes("OUTSIDE-PRIVATE-MARKER"));
  }
});

test("closed, signed-out or mismatched user contexts fail before reading owned bytes", async (t) => {
  for (const kind of ["closed", "signedOut", "user"]) {
    const f = fixture(t);
    await f.history();
    f.calls.length = 0;
    if (kind !== "user") f.retire(kind);
    await assert.rejects(
      f.read(
        { method: "GET", path: `${longBase}/${f.attachment.id}/contents` },
        kind === "user" ? 8 : 7,
      ),
      /session has ended/,
    );
    assert.deepEqual(f.calls, []);
  }
});

test("activation, owner and context retirement during an awaited owned read never return bytes", async (t) => {
  for (const kind of [
    "activation",
    "owner",
    "closed",
    "signedOut",
    "context",
  ]) {
    const f = fixture(t);
    await f.history();
    let completedReads = 0;
    f.after((method) => {
      if (method === "turnAttachment") {
        completedReads++;
        f.retire(kind);
      }
    });
    const response = await f.fetch(`${longBase}/${f.attachment.id}/contents`);
    assert.equal(
      completedReads,
      1,
      "Retirement follows an actual owned read, not an unrelated rejection",
    );
    assert.ok(
      [409, 503].includes(response.status),
      `${kind}: ${response.status}`,
    );
    const error = await response.text();
    assert.ok(!error.includes(text));
    assert.ok(!error.includes(f.root));
  }
});

test("a missing cloud/runner method is a source-unavailable error, never missing-file or local fallback", async (t) => {
  const f = fixture(t);
  await f.history();
  f.logs.length = 0;
  f.dispatcher.methods = f.dispatcher.methods.filter(
    (method: string) => method !== "turnAttachment",
  );
  const response = await f.fetch(`${longBase}/${f.attachment.id}/contents`);
  assert.equal(response.status, 503);
  assert.match(
    f.logs.join("\n"),
    /stage=service-error status=503.*code=CLAUDEX_WEB_METHOD_UNAVAILABLE/,
  );
  assert.doesNotMatch(f.logs.join("\n"), /stage=local-read|stage=service-null/);
  assert.ok(!(await response.text()).includes(text));
});

test("HTML and SVG history files stay inactive octet-stream under every newly allowed raw preview", async (t) => {
  for (const name of ["synthetic.html", "synthetic.svg"]) {
    const data = Buffer.from("<svg onload=alert('INERT-NOT-EXECUTED')></svg>");
    // Native policy intentionally rejects attaching SVG; historical imported
    // metadata can contain it, so seed its inert bytes as text before rename.
    const f = fixture(t, { name: "inert.txt", data });
    const row =
      f.ctx.store.conversation(conversationId).turns[0].attachments[0];
    row.name = name;
    await f.history();
    for (const variant of ["contents", "preview", "thumbnail"]) {
      const response = await f.fetch(
        `${shortBase}/${f.attachment.id}/${variant}`,
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    }
  }
});

test("file reads keep exact GET paths only and reject writes, adjacent APIs and path/query injection", async (t) => {
  const f = fixture(t),
    url = `${longBase}/${f.attachment.id}/contents`;
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    assert.equal(isOfficialUiQuery(method, url), false);
    assert.equal((await f.fetch(url, { method })).status, 501);
  }
  for (const candidate of [
    `${url}/`,
    `${url}/edit`,
    url.replace("contents", "delete"),
    `${shortBase}/${f.attachment.id}`,
    `${longBase}/${"a".repeat(501)}/contents`,
    `${longBase}/a%2Fb/contents`,
    `${longBase}/%2e%2e/contents`,
    `${longBase}/a.b/contents`,
    `${longBase}/a\\b/contents`,
    `${url}?path=/etc/passwd`,
    `${url}?account=other`,
    `/api/${org}/upload`,
    `/api/organizations/${org}/convert_document`,
  ]) {
    const parsed = new URL(candidate, "https://synthetic.example.invalid");
    assert.equal(
      isOfficialUiQuery("GET", parsed.pathname, parsed.search),
      false,
      candidate,
    );
    assert.equal((await f.fetch(candidate)).status, 501, candidate);
    assert.equal(
      (await f.read({ method: "GET", path: candidate })).status,
      501,
      candidate,
    );
  }
  const generatedPdf = url.replace("contents", "document_pdf");
  assert.equal(isOfficialUiQuery("GET", generatedPdf), true);
  assert.equal((await f.fetch(generatedPdf)).status, 404);
  assert.equal((await f.read({ method: "GET", path: generatedPdf })).status, 404);
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    f.read({ method: "GET", path: url }, 7, "officialUiAction"),
    /Not available on the web/,
  );
});

test("official Web converts a multipart document without a write capability", async (t) => {
  const f = fixture(t);
  const route = `/api/organizations/${org}/convert_document`;
  const fileName = "项目笔记.docx";
  const content = "正文 第一页 🦊";
  const mediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const data = await knowledgeDocx(content);
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(data)], { type: mediaType }), fileName);
  const response = await f.fetch(route, { method: "POST", body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    file_name: fileName,
    file_size: data.byteLength,
    file_type: mediaType,
    extracted_content: content,
  });
  assert.equal((await f.fetch(`${route}?other=1`, { method: "POST", body })).status, 501);
  assert.equal((await f.fetch(route, { method: "POST", body: "not multipart" })).status, 400);
  const foreign = route.replace(org, organizationUuid("another-account"));
  assert.equal((await f.fetch(foreign, { method: "POST", body })).status, 404);
  assert.deepEqual(f.calls, []);
});

test("large owned files preserve their bytes with or without gzip negotiation", async (t) => {
  const data=Buffer.alloc(officialUiReadMaxBytes + 1, 120);
  const f = fixture(t, {name:"large.pdf",data});
  await f.history();
  const url=`${longBase}/${f.attachment.id}/contents`;
  const direct=await f.read({method:"GET",path:url,responseTransfer:true});
  assert.equal(direct.status,200);
  assert.equal(direct.responseTransfer?.totalBytes,data.length);
  const legacy = await f.read({ method: "GET", path: url, acceptEncoding: "gzip" });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.responseTransfer, undefined);
  assert.equal(legacy.bodyEncoding, "gzip");
  assert.ok(gunzipSync(legacy.body).equals(data));
  const response=await f.fetch(url);
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);
  assert.equal((await f.fetch("/api/account")).status,200);
});

test("historical attachment IDs cannot select conflicting files from another branch",t=>{
 const f=fixture(t);const c=f.ctx.store.conversation(conversationId),first=c.turns[0].attachments[0];
 const read=()=>f.ctx.handlers.get("turnAttachment")(conversationId,first.id);
 c.savedBranches=[{id:"same",turns:[{...c.turns[0],attachments:[{...first}]}]}];
 assert.equal(Buffer.from(read().data).toString(),text);
 c.savedBranches[0].turns[0].attachments[0].path=path.join(f.root,"different-file");
 assert.equal(read(),null);
 c.savedBranches[0].turns[0].attachments[0]={...first,name:"other.txt"};
 assert.equal(read(),null);
});


test("an incompressible historical attachment beyond a single reply is reassembled", async t => {
  const data = randomBytes(officialUiReadMaxBytes + 1);
  const f = fixture(t, { name: "large.pdf", data });
  await f.history();
  const response = await f.fetch(`${longBase}/${f.attachment.id}/contents`);
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(data));
});
