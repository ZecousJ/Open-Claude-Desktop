import { CloudRouter } from "../electron/cloud/cloud-router";
import { route } from "../electron/cloud/cloud-route";
/** Actual Store and registered upload/read handlers; self-created temporary bytes only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { registerComposerHandlers } from "../electron/ipc/composer";
import { openPolicy } from "../shared/client-policy";
import { filesRoute, learnAttachment } from "../electron/official-ui/api/files";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { organizationUuid } from "../electron/official-ui/api/context";
test("actual uploaded file survives Store reopen; missing file vs missing profile root produce distinct preview outcomes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reopened-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx: any = {
    store: new Store(root),
    policy: () => openPolicy,
    selectedAttachments: new Map(),
    push() {},
  };
  const handlers = new Map<string, any>();
  registerComposerHandlers(
    ((name: string, fn: any) => handlers.set(name, fn)) as any,
    ctx,
  );
  const a = handlers.get("addAttachmentData")(
    "self.txt",
    new TextEncoder().encode("SELF\nORANGE\n"),
    undefined,
  );
  ctx.store.conversations = [
    {
      id: "synthetic-conversation",
      mode: "chat",
      title: "Synthetic only",
      providerId: "p",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "synthetic-turn",
          createdAt: 1,
          status: "completed",
          prompt: "inert",
          items: [],
          attachments: [a],
        },
      ],
    },
  ];
  ctx.store.flush();
  ctx.store = new Store(root);
  assert.equal(
    ctx.store.conversation("synthetic-conversation").turns[0].attachments[0].id,
    a.id,
  );
  const scope = newAdapterScope("synthetic-owner");
  const activation = {};
  let status = 0,
    body: any;
  const logs: unknown[][] = [];
  const router = new CloudRouter({
    client: () => ({
      call: async () => {
        throw Object.assign(new Error("PRIVATE_REMOTE_MESSAGE"), {
          code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
          status: 403,
        });
      },
    }),
  } as any);
  const routed = route.call(
    router,
    "turnAttachment",
    handlers.get("turnAttachment"),
  );
  const adapter: any = {
    account: () => ({ id: "synthetic-owner" }),
    sessionIdentity: () => activation,
    isCurrent: () => true,
    log: (...args: unknown[]) => logs.push(args),
    call: async (name: string, ...args: any[]) => {
      assert.equal(name, "turnAttachment");
      return routed(...args);
    },
  };
  inAdapterScope(scope, () =>
    learnAttachment(
      ctx.store.conversation("synthetic-conversation").turns[0].attachments[0],
      "synthetic-conversation",
    ),
  );
  const run = async () => {
    logs.length = 0;
    await inAdapterScope(scope, () =>
      filesRoute(
        { method: "GET" } as any,
        {
          writeHead: (s: number) => (status = s),
          end: (v: any) => (body = v),
        } as any,
        `/api/organizations/${organizationUuid("synthetic-owner")}/files/${a.id}/contents`,
        adapter,
      ),
    );
    return { status, body, logs: JSON.stringify(logs) };
  };
  let r = await run();
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "SELF\nORANGE\n");
  assert.match(r.logs, /read-success/);
  assert.match(r.logs, /route-local/);
  assert.match(r.logs, /local-read/);
  fs.renameSync(a.path, a.path + ".held");
  r = await run();
  assert.equal(r.status, 404);
  assert.match(r.logs, /service-null/);
  assert.match(r.logs, /local-file-realpath/);
  assert.doesNotMatch(r.logs, /local-file-stat/);
  fs.renameSync(a.path + ".held", a.path);
  fs.renameSync(
    path.join(root, "attachments"),
    path.join(root, "held-attachments"),
  );
  r = await run();
  assert.equal(r.status, 503);
  assert.match(r.logs, /service-error status=503 error=Error/);
  assert.match(r.logs, /local-root-realpath/);
  assert.doesNotMatch(r.logs, /local-file-realpath/);
  assert.match(r.logs, /code=ENOENT/);
  fs.renameSync(
    path.join(root, "held-attachments"),
    path.join(root, "attachments"),
  );
  ctx.store.conversations = [];
  r = await run();
  assert.equal(r.status, 503);
  assert.match(r.logs, /service-error status=503 error=Error/);
  assert.match(r.logs, /local-conversation/);
  assert.doesNotMatch(r.logs, /local-root-realpath/);
  router.conversations.add("synthetic-conversation");
  r = await run();
  assert.equal(r.status, 503);
  assert.match(r.logs, /route-cloud/);
  assert.match(
    r.logs,
    /code=CLAUDEX_WEB_METHOD_UNAVAILABLE service_status=403/,
  );
  assert.doesNotMatch(r.logs, /local-conversation/);
  assert.doesNotMatch(
    r.logs,
    /synthetic-conversation|self.txt|ORANGE|PRIVATE_REMOTE_MESSAGE/,
  );
});
