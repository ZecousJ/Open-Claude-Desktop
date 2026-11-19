import { createHash } from "node:crypto";
import { readState } from "../../electron/official-ui/api/state";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  discardIncognitoRoute,
  creatingConversations,
} from "../../electron/official-ui/api/incognito";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  newAdapterScope,
  inAdapterScope,
} from "../../electron/official-ui/api/scope";
import {
  learnAttachment,
  knownFile,
  aliasCloudAttachments,
} from "../../electron/official-ui/api/files";
const id = "00000000-0000-4000-8000-000000015010",
  other = "00000000-0000-4000-8000-000000015011";
async function run(options: any = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-incognito-route-"),
  );
  const owner = "self-test",
    org = organizationUuid(owner),
    activation = {};
  let active = true,
    calls = 0;
  const attachment = {
    id: "private-file",
    name: "self.txt",
    path: path.join(root, "attachments/private/self.txt"),
    size: 3,
    kind: "text",
    createdAt: 1,
  };
  const c: any = {
    id,
    mode: "chat",
    incognito: !options.ordinary,
    turns: [{ attachments: [attachment] }],
  };
  let rows: any[] = [
    c,
    ...(options.shared
      ? [
          {
            id: other,
            mode: "chat",
            turns: [
              {
                attachments: [
                  options.alias
                    ? { ...attachment, id: "ordinary-alias" }
                    : attachment,
                ],
              },
            ],
          },
        ]
      : []),
  ];
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => activation,
    isCurrent: () => active,
    readOnly: options.readOnly,
    loadConversation: async () => rows.find((row) => row.id === id),
    listConversations: async () => rows,
    call: async (method: string, got: string) => {
      assert.equal(method, "discardIncognito");
      assert.equal(got, id);
      calls++;
      rows = rows.filter((x) => x !== c);
    },
  };
  const res: any = {
    statusCode: 200,
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {},
    setHeader() {},
  };
  const pathname = `/api/organizations/${options.foreign ? "foreign" : org}/chat_conversations/${id}/discard_incognito`;
  try {
    return await inAdapterScope(
      newAdapterScope(owner, root, activation),
      async () => {
        learnAttachment(attachment as any, id);
        if (options.alias) {
          aliasCloudAttachments(["private-file"], [
            { ...attachment, id: "ordinary-alias" },
          ] as any);
          aliasCloudAttachments(["private-file"], [
            { ...attachment, id: "temporary-alias" },
          ] as any);
          c.turns[0].attachments = [{ ...attachment, id: "temporary-alias" }];
        }
        let release: any;
        if (options.pending) {
          creatingConversations.set(id, new Promise((r) => (release = r)));
          setTimeout(() => {
            if (options.retire) active = false;
            release();
          }, 2);
        }
        const invoke = () =>
          discardIncognitoRoute(
            { method: options.method ?? "POST" } as any,
            res,
            pathname,
            new URL("http://self" + pathname),
            ctx,
            (x) => x,
          );
        let firstSaveFailed = false;
        if (options.saveFailure) {
          const rename = fs.renameSync;
          fs.renameSync = ((from: any, to: any) => {
            if (
              String(to).startsWith(root + path.sep) &&
              String(to).endsWith("/files.json")
            )
              throw Error("Self test registry save failure");
            return rename(from, to);
          }) as typeof fs.renameSync;
          try {
            await assert.rejects(
              invoke(),
              /Official UI state could not be saved/,
            );
            firstSaveFailed = true;
          } finally {
            fs.renameSync = rename;
          }
          assert.equal(
            rows.some((row) => row.id === id),
            false,
          );
          await invoke();
        } else await invoke();
        const registryFile = path.join(
          root,
          "official-ui",
          "accounts",
          createHash("sha256").update(owner).digest("hex"),
          "files.json",
        );
        const persistedBeforeTestFlush = fs.existsSync(registryFile)
          ? JSON.parse(fs.readFileSync(registryFile, "utf8"))
          : null;
        readState("files", {});
        return {
          status: res.statusCode,
          persistedBeforeTestFlush,
          firstSaveFailed,
          calls,
          file: knownFile("private-file"),
        };
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("exact temporary POST calls discard and forgets its registry", async () => {
  const r = await run();
  assert.equal(r.status, 204);
  assert.equal(r.calls, 1);
  assert.equal(r.file, undefined);
  assert.deepEqual(r.persistedBeforeTestFlush.files, []);
});
test("ordinary file shared reference survives with ordinary binding", async () => {
  const r = await run({ shared: true });
  assert.equal(r.status, 204);
  assert.equal(r.file?.conversationId, other);
});
test("readOnly and foreign organization reject before handler", async () => {
  for (const [o, status] of [
    [{ readOnly: true }, 501],
    [{ foreign: true }, 404],
  ] as any) {
    const r = await run(o);
    assert.equal(r.status, status);
    assert.equal(r.calls, 0);
  }
});
test("ordinary conversation cannot be discarded", async () => {
  const r = await run({ ordinary: true });
  assert.equal(r.status, 409);
  assert.equal(r.calls, 0);
});
test("pending first-send waits and retirement prevents mutation", async () => {
  const ok = await run({ pending: true });
  assert.equal(ok.calls, 1);
  const stale = await run({ pending: true, retire: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.calls, 0);
});
test("non-POST rejects", async () => {
  const r = await run({ method: "GET" });
  assert.equal(r.status, 405);
  assert.equal(r.calls, 0);
});

test("distinct ordinary and temporary aliases preserve same owned registry file", async () => {
  const r = await run({ shared: true, alias: true });
  assert.equal(r.status, 204);
  assert.equal(r.file?.conversationId, other);
});

test("registry save failure refuses success; explicit retry flushes before 204 without rediscard", async () => {
  const r = await run({ saveFailure: true });
  assert.equal(r.firstSaveFailed, true);
  assert.equal(r.status, 204);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.persistedBeforeTestFlush.files, []);
});
