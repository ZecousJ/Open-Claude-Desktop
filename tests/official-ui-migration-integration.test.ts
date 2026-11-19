import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApiAdapter } from "../electron/official-ui/api/index";
import { organizationUuid } from "../electron/official-ui/api/context";
import { setStateDir } from "../electron/official-ui/api/state";

test("legacy conversation aliases migrate only to their owning account through the HTTP adapter", async () => {
  const previous = process.env.CLAUDEX_OFFICIAL_SCOPED_STATE;
  process.env.CLAUDEX_OFFICIAL_SCOPED_STATE = "1";
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-migration-http-"),
  );
  setStateDir(path.join(root, "legacy"));
  const oldFile = path.join(root, "legacy", "official-ui", "aliases.json");
  fs.writeFileSync(
    oldFile,
    JSON.stringify([
      ["page-a", "real-a"],
      ["page-b", "real-b"],
    ]),
  );
  const context = (id: string) => {
    const c = {
      id: `real-${id}`,
      title: `test-${id}`,
      mode: "chat",
      model: "m",
      providerId: "p",
      turns: [],
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    };
    return {
      root: path.resolve("build/official-ui"),
      stateDirectory: () => path.join(root, id),
      account: () => ({ id }),
      listConversations: async () => [c],
      loadConversation: async (key: string) => (key === c.id ? c : undefined),
      log() {},
    };
  };
  const a = createApiAdapter(context("a") as never),
    b = createApiAdapter(context("b") as never);
  const server = http.createServer((req, res) => {
    void (req.headers["x-test-account"] === "a" ? a(req, res) : b(req, res))
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const get = (
      account: string,
      id: string,
      org = organizationUuid(account),
    ) =>
      fetch(
        `http://127.0.0.1:${port}/api/organizations/${org}/chat_conversations/${id}`,
        { headers: { "x-test-account": account } },
      );
    const [aa, bb] = await Promise.all([
      get("a", "page-a"),
      get("b", "page-b"),
    ]);
    assert.equal(aa.status, 200);
    assert.equal(bb.status, 200);
    assert.equal((await get("a", "page-a", organizationUuid("b"))).status, 404);
    assert.equal((await get("a", "page-b")).status, 404);
    assert.equal((await get("b", "page-a")).status, 404);
    assert.equal(JSON.parse(fs.readFileSync(oldFile, "utf8")).length, 2);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined)
      delete process.env.CLAUDEX_OFFICIAL_SCOPED_STATE;
    else process.env.CLAUDEX_OFFICIAL_SCOPED_STATE = previous;
  }
});
