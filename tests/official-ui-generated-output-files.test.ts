import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  createGeneratedOutputFixture,
  outputConversationId,
} from "./support/generated-output-fixture";
import {
  generatedOutputFileRoute,
  codeOutputAttachment,
  flushGeneratedOutputBindings,
  generatedOutputAttachments,
  generatedWorkspaceOutputs,
} from "../electron/official-ui/api/generated-output-files";
import {
  conversationUpdate,
  loadRegistry,
  deepCreate,
} from "../electron/official-ui/api/timeline";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { organizationUuid } from "../electron/official-ui/api/context";
import { createApiAdapter } from "../electron/official-ui/api/index";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import { captureOutputFiles } from "../electron/artifacts/generated-files";
import type { Conversation, Item } from "../shared/types";
async function setup(t: any, documents = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f019-test-"));
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = await createGeneratedOutputFixture(root, documents);
  let scope = newAdapterScope("f019-owner", f.profile, f.ctx.sessionIdentity());
  const run = <T>(fn: () => T) => inAdapterScope(scope, fn);
  const org = organizationUuid("f019-owner");
  return {
    ...f,
    get store() {
      return f.store;
    },
    get reads() {
      return f.reads;
    },
    run,
    org,
    async read(
      id: string,
      variant = "contents",
      method = "GET",
      foreign = false,
    ) {
      let status = 0,
        body: any,
        headers: any;
      const p = `/api/organizations/${foreign ? organizationUuid("other") : org}/files/${id}/${variant}`;
      const handled = await run(() =>
        generatedOutputFileRoute(
          { method } as any,
          {
            writeHead: (s: number, h: any) => {
              status = s;
              headers = h;
            },
            end: (v: any) => (body = v),
          } as any,
          p,
          new URL(p, "http://local"),
          f.ctx,
        ),
      );
      return { handled, status, body, headers };
    },
    publish() {
      return run(() =>
        generatedOutputAttachments(
          org,
          outputConversationId,
          f.store.conversations[0].turns[0],
        ),
      );
    },
    restart() {
      f.restart();
      scope = newAdapterScope("f019-owner", f.profile, f.ctx.sessionIdentity());
    },
  };
}
test("workspace outputs preserve both files when different folders use the same filename", async (t) => {
  const f = await setup(t, true);
  const outputs = f.run(() =>
    generatedWorkspaceOutputs(
      f.org,
      outputConversationId,
      f.store.conversations[0].turns,
    ),
  );
  const summaries = outputs.filter(
    (file) => file.displayName === "summary.txt",
  );
  assert.equal(summaries.length, 2);
  assert.equal(new Set(summaries.map((file) => file.path)).size, 2);
  const attachments = f
    .publish()
    .filter((file) => file.fileName === "summary.txt");
  assert.equal(attachments.length, 2);
  assert.deepEqual(
    attachments.map((file) => file.path).sort(),
    summaries.map((file) => file.path).sort(),
  );
  assert.deepEqual(
    attachments.map((file) => file.sessionPath).sort(),
    summaries.map((file) => file.path).sort(),
  );
  const contents = await Promise.all(
    summaries.map(async (file) => (await f.read(file.fileId)).body.toString()),
  );
  assert.deepEqual(contents.sort(), ["Archived summary", "Report summary"]);
  for (const file of f.store.conversations[0].turns[0].items.at(-1)!
    .generatedFiles!)
    if (file.name === "summary.txt") file.tooLarge = true;
  const unavailable = f
    .publish()
    .filter((file) => file.fileName.endsWith("/summary.txt"));
  assert.equal(unavailable.length, 2);
  assert.ok(unavailable.every((file) => file.unavailable));
  assert.deepEqual(
    unavailable.map((file) => file.fileName).sort(),
    summaries.map((file) => file.path).sort(),
  );
});

test("Chat image cards open their own snapshots when two replies write the same path", async (t) => {
  const f = await setup(t);
  const conversation = f.store.conversations[0];
  const imagePath = path.join(f.workspace, "edited.png");
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/1vnp0AAAAABJRU5ErkJggg==", "base64");
  const revised = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const baseTurn = conversation.turns[0];
  conversation.turns = [original, revised].map((bytes, index) => {
    const id = `image-edit-${index}`;
    fs.writeFileSync(imagePath, bytes);
    const generatedFiles = captureOutputFiles(
      f.workspace, 0, new Set(), f.blobs, id, new Set([".png"]),
    );
    return {
      ...baseTurn,
      id,
      items: [{ id, type: "outputFiles", status: "completed", generatedFiles }],
    };
  });
  f.store.flush();
  const attachments = f.run(() => {
    const rows = conversation.turns.flatMap((turn) =>
      generatedOutputAttachments(f.org, conversation.id, turn),
    );
    const outputs = generatedWorkspaceOutputs(f.org, conversation.id, conversation.turns);
    assert.deepEqual(outputs.map((row) => [row.path, row.fileId]),
      rows.map((row) => [row.sessionPath, row.id]));
    flushGeneratedOutputBindings();
    return rows;
  });
  assert.deepEqual(attachments.map((row) => row.path), [imagePath, imagePath]);
  assert.equal(new Set(attachments.map((row) => row.sessionPath)).size, 2);
  f.restart();
  for (const [index, attachment] of attachments.entries()) {
    const response = await f.read(attachment.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, index === 0 ? original : revised);
  }
});

test("cold Native Code history opens immutable document and image bytes in the original file endpoints", async (t) => {
  const f = await setup(t);
  const c: Conversation = f.store.conversations[0];
  c.mode = "code";
  const turn = c.turns[0];
  const output = turn.items.at(-1)!;
  const document = output.generatedFiles!.find(({ name }) =>
    name.endsWith(".xlsx"),
  )!;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/1vnp0AAAAABJRU5ErkJggg==",
    "base64",
  );
  const savedPath = path.join(f.blobs.imageFolder, "thread", "generated.png");
  fs.mkdirSync(path.dirname(savedPath), { recursive: true });
  fs.writeFileSync(savedPath, png);
  const picture: Item = { id: "image", type: "imageGeneration", savedPath };
  turn.items.push(picture);
  f.store.flush();

  f.ctx.withOfficialApiScope = f.run;
  f.ctx.localLoadConversation = f.ctx.loadConversation;
  f.ctx.localCall = f.ctx.call;
  f.ctx.call = async () => {
    throw Error("Native Code file bytes must stay local.");
  };
  const native = createNativeAccountApi(f.ctx);
  const generic = createApiAdapter(f.ctx, {
    scoped: true,
    migrateLegacy: false,
  });
  const server = createServer((req, res) => {
    const handle = req.url?.startsWith("/api/bootstrap") ? generic : native;
    void handle(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(404).end();
      })
      .catch((error) => res.destroy(error));
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (url: string) =>
    fetch(`http://127.0.0.1:${address.port}${url}`);
  const publish = () =>
    f.run(() => {
      const attachments = [
        codeOutputAttachment(f.ctx, c, turn, output, document),
        codeOutputAttachment(f.ctx, c, turn, picture),
      ];
      flushGeneratedOutputBindings();
      return attachments;
    });
  const [file, image] = publish();
  assert.ok(file?.file_uuid && image?.file_uuid);
  assert.equal(file.path, document.name);
  assert.equal(image.path, "generated.png");
  assert.equal(image.isImage, true);
  const contents = `/api/organizations/${f.org}/files/${file.file_uuid}/contents`;
  const thumbnail = `/api/${f.org}/files/${image.file_uuid}/thumbnail`;
  const foreign = contents.replace(f.org, organizationUuid("foreign"));
  assert.equal((await request(foreign)).status, 404);
  assert.equal(f.reads, 0);

  fs.writeFileSync(savedPath, "replacement");
  fs.rmSync(f.workspace, { recursive: true });
  const downloaded = await request(contents);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), f.bytes);
  const preview = await request(thumbnail);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);

  f.restart();
  assert.deepEqual(publish(), [file, image]);
  const reopened = await request(thumbnail);
  assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), png);
  f.store.conversations[0].sessionAuthors = {
    ownerAccountUuid: "foreign",
    viewerAccountUuid: "f019-owner",
  };
  assert.equal((await request(contents)).status, 404);
  f.ctx.account = () => undefined;
  f.ctx.withOfficialApiScope = () => {
    throw Error("Signed-out requests must not enter an account scope.");
  };
  assert.equal((await request(contents)).status, 401);
  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).is_anonymous, true);
});
test("Windows output paths retain their drive and directories in the Chat session path", async (t) => {
  const f = await setup(t);
  const turn = f.store.conversations[0].turns[0];
  const file = turn.items
    .at(-1)!
    .generatedFiles!.find((file) => file.name.endsWith(".txt"))!;
  file.path = "C:\\Reports\\说明.txt";
  const attachment = f.publish().find((row) => row.fileName === file.name)!;
  const output = f
    .run(() => generatedWorkspaceOutputs(f.org, outputConversationId, [turn]))
    .find((row) => row.fileId === attachment.id)!;
  assert.equal(attachment.path, file.path);
  assert.equal(attachment.sessionPath, "/C:/Reports/说明.txt");
  assert.equal(output.path, attachment.sessionPath);
  assert.equal((await f.read(attachment.id)).body.toString(), file.content);
});
test("real captured XLSX/text reach protocol output attachments and reloadable verified bytes", async (t) => {
  const f = await setup(t);
  const list = f.publish();
  assert.equal(list.length, 2);
  const excel = list.find((x) => x.fileName.endsWith(".xlsx"))!;
  assert.ok(excel);
  const result = await f.read(excel.id);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, f.bytes);
  assert.match(result.headers["Content-Disposition"], /filename\*=UTF-8/);
  assert.match(result.headers["Content-Security-Policy"], /sandbox/);
  const text = list.find((x) => x.fileName.endsWith(".txt"))!;
  assert.equal(
    (await f.read(text.id)).body.toString(),
    "F019 generated text 中文",
  );
  const registry = loadRegistry(
      "build/official-ui/data/conversation-protocol.json",
    ),
    schema = registry.getMessage(
      "anthropic.bard.api.v1alpha.ConversationUpdate",
    )!;
  const update = f.run(() =>
    conversationUpdate(f.store.conversations[0], false, {
      org: f.org,
      registry,
    }),
  );
  const decoded: any = fromBinary(
    schema,
    toBinary(schema, deepCreate(schema, update)),
  );
  assert.equal(decoded.conversation.hasAssistantOutputs, true);
  assert.equal(decoded.conversation.outputs.length, 2);
  assert.equal(
    decoded.messages.find((m: any) => m.role === 2).attachments.length,
    2,
  );
  assert.ok(
    decoded.conversation.extras.some((e: any) =>
      e.typeUrl.endsWith(".WorkspaceOutputs"),
    ),
  );
  fs.rmSync(f.workspace, { recursive: true });
  f.restart();
  assert.deepEqual((await f.read(excel.id)).body, f.bytes);
  assert.equal((await f.read(excel.id, "contents", "HEAD")).body, undefined);
});
test("foreign org, missing transcript and mutated source cannot authorize stored registry bytes", async (t) => {
  const f = await setup(t),
    file = f.publish().find((x) => x.fileName.endsWith(".xlsx"))!;
  assert.equal((await f.read(file.id, "contents", "GET", true)).status, 404);
  assert.equal(f.reads, 0);
  f.store.conversations[0].turns[0].items.at(-1)!.generatedFiles = [];
  assert.equal((await f.read(file.id)).status, 409);
  assert.equal(f.reads, 0);
  f.store.conversations = [];
  assert.equal((await f.read(file.id)).status, 404);
});
test("missing binary snapshot and retired reads return an error", async (t) => {
  const f = await setup(t),
    file = f.publish().find((x) => x.fileName.endsWith(".xlsx"))!;
  const source = f.files.find((x) => x.name.endsWith(".xlsx"))!;
  fs.unlinkSync(f.blobs.path(source.digest!));
  assert.equal((await f.read(file.id)).status, 503);
  f.ctx.call = async () => {
    f.retire();
    return f.bytes.toString("base64");
  };
  assert.equal((await f.read(file.id)).status, 409);
});
test("inactive/oversize snapshots are visible as unavailable and binary files never fake text or PDF", async (t) => {
  const f = await setup(t),
    list = f.publish(),
    excel = list.find((x) => x.fileName.endsWith(".xlsx"))!;
  assert.equal((await f.read(excel.id, "content_preview")).status, 501);
  assert.equal((await f.read(excel.id, "document_pdf")).status, 501);
  const source = f.store.conversations[0].turns[0].items
    .at(-1)!
    .generatedFiles!.find((x) => x.name.endsWith(".xlsx"))!;
  source.tooLarge = true;
  assert.equal(
    f.publish().find((x) => x.fileName.endsWith(".xlsx"))!.unavailable,
    true,
  );
  assert.equal((await f.read(excel.id)).status, 409);
});

test("a new version has a different ID while saved branches retain the original snapshot", async (t) => {
  const f = await setup(t),
    first = f.publish().find((x) => x.fileName.endsWith(".xlsx"))!;
  const old = structuredClone(f.store.conversations[0].turns);
  f.store.conversations[0].savedBranches = [{ id: "saved", turns: old } as any];
  const current = f.store.conversations[0].turns[0];
  current.id = "new-turn";
  const changed = current.items
    .at(-1)!
    .generatedFiles!.find((x) => x.name.endsWith(".xlsx"))!;
  changed.name = "新版本.xlsx";
  const second = f.publish().find((x) => x.fileName.endsWith(".xlsx"))!;
  assert.notEqual(first.id, second.id);
  assert.deepEqual((await f.read(first.id)).body, f.bytes);
  assert.deepEqual((await f.read(second.id)).body, f.bytes);
});

test("temporary file created and deleted in the same turn is not presented as a delivered file", async (t) => {
  const f = await setup(t),
    turn = f.store.conversations[0].turns[0];
  const source = structuredClone(turn.items.at(-1)!.generatedFiles![0]);
  source.id = "helper";
  source.name = "helper.py";
  source.path = "/synthetic/helper.py";
  turn.items.unshift(
    { id: "helper-create", type: "fileChange", generatedFiles: [source] },
    {
      id: "helper-remove",
      type: "fileChange",
      generatedFiles: [
        {
          ...source,
          id: "helper-deleted",
          operation: "delete",
          state: "deleted",
          digest: undefined,
          content: undefined,
          blob: false,
          bytes: undefined,
        },
      ],
    },
  );
  assert.deepEqual(
    f
      .publish()
      .map((f) => f.fileName)
      .sort(),
    ["版本对比.xlsx", "说明.txt"].sort(),
  );
});

test("host transport limits refuse oversized reads explicitly before fetching binary content", async (t) => {
  const f = await setup(t),
    file = f.publish().find((x) => x.fileName.endsWith(".xlsx"))!;
  f.ctx.generatedFileReadMaxBytes = 1;
  assert.equal((await f.read(file.id)).status, 413);
  assert.equal(f.reads, 0);
});
