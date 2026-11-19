import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { Store } from "../../electron/store/store";
import { readOfficialCodeWorkspace } from "../../runner/src/official-code-workspace";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { officialCodeWorkspace } from "../../shared/official-code-workspace";
import type { Conversation } from "../../shared/types";

test("workspace route confines and returns native file, search, mention and Changes data", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-workspace-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const store = new Store(path.join(temp, "profile"));
  const spaceRoot = (id: string) => path.join(store.root, "spaces", id);
  const cwd = path.join(spaceRoot("fixture"), "workspace", "code", "12345678");
  fs.mkdirSync(path.join(cwd, "nested"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "nested", "hello.txt"), "hello needle\n");
  fs.writeFileSync(path.join(temp, "secret"), "SECRET");
  fs.writeFileSync(path.join(cwd, "example.docx"), "ASCII office bytes");
  fs.symlinkSync(path.join(temp, "secret"), path.join(cwd, "escape"));
  const code = {
    id: "c",
    mode: "code",
    cwd,
    environment: { kind: "space", spaceId: "fixture" },
  } as Conversation;
  store.conversations = [code];
  const git = (dir: string, args: string[], okCodes = [0]) => {
    try {
      return Promise.resolve(
        execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch (e) {
      if (okCodes.includes((e as { status: number }).status))
        return Promise.resolve(String((e as { stdout: string }).stdout));
      throw e;
    }
  };
  await git(cwd, ["init", "-q"]);
  const host = {
    git,
    entries: async (_: string, files: string[]) =>
      new Map(
        files.map((f) => [
          f,
          { kind: "file" as const, size: fs.statSync(path.join(cwd, f)).size },
        ]),
      ),
    lineCounts: async () => ({}),
  };
  const ctx = {
    userId: 42,
    activeAccount: { id: "owner" },
    store,
    spaceRoot,
    services: {},
    runtime: {
      workingTree: (input: unknown) => {
        assert.deepEqual(input, {
          userId: 42,
          storeRoot: spaceRoot("fixture"),
          spaceId: "fixture",
        });
        return host;
      },
    },
  } as unknown as WebAppContext;
  const route = `/v1/code/sessions/session_${cloudCodeSessionKey(code, "owner")}/workspace`;
  const run = async (
    params: Record<string, string>,
    org = organizationUuid("owner"),
    modes = ["code"],
  ) => {
    const query = officialCodeWorkspace(
      "GET",
      route,
      `?${new URLSearchParams(params)}`,
    );
    assert.ok(query);
    const response = await readOfficialCodeWorkspace(ctx, query, org, modes);
    return {
      status: response.status,
      body: JSON.parse(Buffer.from(response.body).toString()),
    };
  };
  const listing = await run({ op: "list", path: "/workspace" });
  assert.ok(
    listing.body.some(
      (entry: { path: string }) => entry.path === "/workspace/nested",
    ),
  );
  assert.ok(!JSON.stringify(listing).includes(cwd));
  const read = await run({ op: "read", path: "/workspace/nested/hello.txt" });
  assert.equal(read.body.file.contents, "hello needle\n");
  assert.equal(read.body.file.absPath, "/workspace/nested/hello.txt");
  assert.equal(
    (await run({ op: "read", path: "escape" })).body.status,
    "outsideSessionFolders",
  );
  assert.equal(
    (await run({ op: "read", path: "../secret" })).body.status,
    "outsideSessionFolders",
  );
  assert.equal(
    (
      await run(
        { op: "read", path: "nested/hello.txt" },
        organizationUuid("other"),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await run(
        { op: "read", path: "nested/hello.txt" },
        organizationUuid("owner"),
        [],
      )
    ).status,
    404,
  );
  const office = await run({ op: "read", path: "example.docx" });
  assert.equal(office.body.file.encoding, "base64");
  assert.equal(
    Buffer.from(office.body.file.contents, "base64").toString(),
    "ASCII office bytes",
  );
  assert.equal(
    office.body.file.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const search = await run({ op: "search", query: "needle" });
  assert.equal(search.body.matches[0].relativePath, "nested/hello.txt");
  assert.equal(search.body.matches[0].absPath, "/workspace/nested/hello.txt");
  assert.ok(
    (await run({ op: "mentions", query: "hello" })).body.some(
      (entry: { label: string }) => entry.label === "nested/hello.txt",
    ),
  );
  const changes = await run({ op: "changes" });
  assert.equal(changes.body.status, "ok");
  assert.ok(
    changes.body.diff.perFileStats.some(
      (entry: { path: string; isUntracked: boolean }) =>
        entry.path === "nested/hello.txt" && entry.isUntracked,
    ),
  );
  assert.equal(
    officialCodeWorkspace("GET", route, "?op=read&path=a&path=b"),
    undefined,
  );
  assert.equal(officialCodeWorkspace("POST", route, "?op=changes"), undefined);
});
