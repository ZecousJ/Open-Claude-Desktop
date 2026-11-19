/** Actual project route, mock source, inert bytes only. No project/filesystem mutations. */
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { projectsRoute } from "../electron/official-ui/api/projects";
import { organizationUuid } from "../electron/official-ui/api/context";
import { knowledgeFileLimit } from "../shared/collections-api";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-upload-test-"));
  roots.push(root);
  let stored: any = undefined;
  let identity = 1,
    owner = "owner",
    retire = "",
    fail = false,
    loseReply = false,
    result: any = undefined;
  const calls: any[] = [];
  const ctx: any = {
    account: () =>
      owner ? { id: owner, email: "fixture@example.invalid" } : undefined,
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    snapshot: async () => {
      if (retire === "snapshot") identity++;
      return { projects: [{ id: "p", kind: "chat", name: "P", createdAt: 1 }] };
    },
    call: async (method: string, ...args: any[]) => {
      calls.push([method, ...args]);
      if (fail) throw Error("secret /private/path service failure");
      if (method === "readProjectKnowledge") {
        if (retire === "read") identity++;
        const data = stored.data;
        return stored.name.endsWith(".pdf")
          ? {
              kind: "pdf",
              name: stored.name,
              bytes: data.byteLength,
              base64: Buffer.from(data).toString("base64"),
            }
          : {
              kind: "text",
              name: stored.name,
              bytes: data.byteLength,
              text: new TextDecoder("utf-8", { fatal: true }).decode(data),
            };
      }
      if (method === "listProjectKnowledge")
        return {
          files: stored
            ? [
                {
                  name: stored.name,
                  bytes: stored.data.byteLength,
                  addedAt: 1234,
                },
              ]
            : [],
        };
      if (method === "confirmProjectKnowledgeUpload") return;
      assert.equal(method, "addProjectKnowledgeFiles");
      if (retire === "write") identity++;
      stored = args[1][0];
      if (loseReply) {
        loseReply = false;
        throw Error("Fixture upload reply lost after storage");
      }
      return result === undefined
        ? {
            files: [
              {
                name: stored.name,
                bytes: stored.data.byteLength,
                addedAt: 1234,
              },
            ],
          }
        : result;
    },
  };
  async function run(
    options: {
      name?: string;
      data?: Uint8Array;
      fields?: [string, string][];
      multiple?: boolean;
      method?: string;
      foreign?: boolean;
      malformed?: boolean;
      abort?: boolean;
      bodyRace?: boolean;
      query?: string;
    } = {},
  ) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(options.data ?? [104, 105])]),
      options.name ?? "note.txt",
    );
    if (options.multiple) form.append("file", new Blob(["other"]), "other.txt");
    for (const [k, v] of options.fields ?? []) form.append(k, v);
    const request = new Request("http://fixture.invalid", {
      method: "POST",
      body: form,
    });
    const bytes = options.malformed
      ? Buffer.from("bad multipart")
      : Buffer.from(await request.arrayBuffer());
    const req: any = Readable.from(
      (async function* () {
        if (options.bodyRace) identity++;
        yield bytes;
      })(),
    );
    req.method = options.method ?? "POST";
    req.headers = { "content-type": request.headers.get("content-type") };
    req.aborted = !!options.abort;
    const p = `/api/organizations/${organizationUuid(options.foreign ? "other" : "owner")}/projects/p/upload`;
    let status = 0,
      data: any;
    const res: any = {
      writeHead: (s: number) => (status = s),
      end: (v: string) => (data = JSON.parse(v)),
    };
    await projectsRoute(
      req,
      res,
      p,
      new URL(p + (options.query ?? ""), "http://fixture.invalid"),
      ctx,
    );
    return { status, data };
  }
  return {
    run,
    ctx,
    calls,
    changeStored: (data: Uint8Array) => (stored = { ...stored, data }),
    reactivate: () => identity++,
    retire: (v: string) => (retire = v),
    fail: () => (fail = true),
    recover: () => (fail = false),
    loseReply: () => (loseReply = true),
    set: (v: any) => (result = v),
    signout: () => (owner = ""),
  };
}
test("single upload uses real normalized metadata and relative folder, recording client identity for later reuse", async () => {
  const f = fixture();
  const r = await f.run({
    name: "a?.txt",
    fields: [
      ["relative_dir", "notes"],
      ["client_upload_id", "synthetic-id"],
      ["reuse_first_upload", "false"],
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.file_name, "notes/a.txt");
  assert.equal(r.data.created_at, new Date(1234).toISOString());
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0][2][0].name, "notes/a.txt");
  assert.deepEqual([...f.calls[0][2][0].data], [104, 105]);
});
test("missing/malformed/duplicate/wrong-size source answer never synthesizes success", async () => {
  for (const result of [
    null,
    {},
    { files: [] },
    { files: [{ name: "note.txt", bytes: 3, addedAt: 1 }] },
    { files: [{ name: "note.txt", bytes: 2, addedAt: NaN }] },
    { files: Array(2).fill({ name: "note.txt", bytes: 2, addedAt: 1 }) },
  ]) {
    const f = fixture();
    f.set(result);
    const r = await f.run();
    assert.equal(r.status, 503);
    assert.equal(r.data.success, undefined);
  }
  const f = fixture();
  f.fail();
  const r = await f.run();
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r), /secret|private/);
});
test("bounds/type/encoding/relative path/multipart validation rejects before dispatch", async () => {
  for (const options of [
    { multiple: true },
    { malformed: true },
    { name: "bad.exe" },
    { name: "bad.pdf" },
    { data: new Uint8Array([255]) },
    { data: new Uint8Array(knowledgeFileLimit + 1) },
    { fields: [["relative_dir", "../outside"]] },
    { fields: [["unknown", "x"]] },
    {
      fields: [
        ["relative_dir", "a"],
        ["relative_dir", "b"],
      ],
    },
    { fields: [["reuse_first_upload", "invalid"]] },
  ]) {
    const f = fixture();
    const r = await f.run(options as any);
    assert.ok([400, 413].includes(r.status), JSON.stringify(r));
    assert.equal(f.calls.length, 0);
  }
});
const reusable: [string, string][] = [
  ["client_upload_id", "synthetic-id"],
  ["reuse_first_upload", "true"],
];
test("reuse-first recovers a stored upload after its reply was lost, without another write", async () => {
  const f = fixture();
  f.loseReply();
  assert.equal((await f.run({ fields: reusable })).status, 503);
  f.reactivate();
  const recovered = await f.run({ fields: reusable });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.success, true);
  assert.deepEqual(await f.run({ fields: reusable }), recovered);
  assert.equal(f.calls.filter(c => c[0] === "addProjectKnowledgeFiles").length, 1);
});
test("pending upload readback errors and changed bytes do not repeat a mutation", async () => {
  const f = fixture();
  f.loseReply();
  assert.equal((await f.run({ fields: reusable })).status, 503);
  f.fail();
  assert.equal((await f.run({ fields: reusable })).status, 503);
  f.recover();
  f.changeStored(new Uint8Array([120, 120]));
  assert.equal((await f.run({ fields: reusable })).status, 409);
  assert.equal(f.calls.filter(c => c[0] === "addProjectKnowledgeFiles").length, 1);
});
test("a failed upload with no stored file requires a new selection and does not prevent that selection", async () => {
  const f = fixture();
  f.fail();
  assert.equal((await f.run({ fields: reusable })).status, 503);
  f.recover();
  const retry = await f.run({ fields: reusable });
  assert.equal(retry.status, 409);
  assert.match(JSON.stringify(retry.data), /Select the file again/);
  assert.equal(f.calls.filter(c => c[0] === "addProjectKnowledgeFiles").length, 1);
  assert.equal((await f.run({ fields: [["client_upload_id", "new-selection"], ["reuse_first_upload", "true"]] })).status, 200);
});
test("real new-consumer reuse-first request survives activation, proves current bytes, dispatches once", async () => {
  const f = fixture();
  assert.equal((await f.run({ fields: reusable })).status, 200);
  f.reactivate();
  assert.equal((await f.run({ fields: reusable })).status, 200);
  assert.equal(
    f.calls.filter((c) => c[0] === "addProjectKnowledgeFiles").length,
    1,
  );
  f.changeStored(new Uint8Array([120, 120]));
  assert.equal((await f.run({ fields: reusable })).status, 409);
  assert.equal(
    f.calls.filter((c) => c[0] === "addProjectKnowledgeFiles").length,
    1,
  );
});
test("UTF8 BOM, double BOM, BOM-only, empty, CRLF and actual PDF are compared by original bytes", async () => {
  for (const text of [
    "",
    "\ufeff",
    "\ufeffhello",
    "\ufeff\ufeffhi",
    "line\r\nnext",
  ]) {
    const f = fixture();
    const data = Buffer.from(text);
    assert.equal(
      (await f.run({ fields: reusable, data })).status,
      200,
      JSON.stringify(text),
    );
    assert.equal(
      (await f.run({ fields: reusable, data })).status,
      200,
      JSON.stringify(text),
    );
    assert.equal(
      f.calls.filter((c) => c[0] === "addProjectKnowledgeFiles").length,
      1,
    );
  }
  const f = fixture();
  const data = Buffer.from("%PDF-1.7 inert");
  assert.equal(
    (await f.run({ fields: reusable, name: "inert.pdf", data })).status,
    200,
  );
  assert.equal(
    (await f.run({ fields: reusable, name: "inert.pdf", data })).status,
    200,
  );
});
test("same-ID different content conflicts and uncertain first mutation never redispatches", async () => {
  const f = fixture();
  assert.equal((await f.run({ fields: reusable })).status, 200);
  assert.equal(
    (await f.run({ fields: reusable, data: new Uint8Array([120, 120]) }))
      .status,
    409,
  );
  assert.equal(
    f.calls.filter((c) => c[0] === "addProjectKnowledgeFiles").length,
    1,
  );
  const g = fixture();
  g.set({ files: [] });
  assert.equal((await g.run({ fields: reusable })).status, 503);
  assert.equal((await g.run({ fields: reusable })).status, 200);
  assert.equal(g.calls.filter(c => c[0] === "addProjectKnowledgeFiles").length, 1);
});
test("concurrent repeats cannot dispatch twice; read-time retirement prevents confirmation", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.run({ fields: reusable }),
    f.run({ fields: reusable }),
  ]);
  assert.ok(results.some((r) => r.status === 200));
  assert.ok(results.every((r) => [200, 409].includes(r.status)));
  assert.equal(
    f.calls.filter((c) => c[0] === "addProjectKnowledgeFiles").length,
    1,
  );
  const g = fixture();
  g.retire("read");
  assert.equal((await g.run({ fields: reusable })).status, 409);
  g.retire("");
  assert.equal((await g.run({ fields: reusable })).status, 200);
  assert.equal(
    g.calls.filter((c) => c[0] === "addProjectKnowledgeFiles").length,
    1,
  );
});
test("account switch before/while body/after mutation cannot claim success; no second dispatch", async () => {
  for (const stage of ["snapshot", "body", "write"]) {
    const f = fixture();
    if (stage !== "body") f.retire(stage);
    const r = await f.run({ bodyRace: stage === "body" });
    assert.equal(r.status, 409);
    assert.equal(f.calls.length, stage === "write" ? 1 : 0);
    assert.equal(r.data.success, undefined);
  }
});
test("cancel/method/foreignorg/readonly/query guard mutation; ordinary retry stays explicit replacement semantics", async () => {
  for (const options of [
    { abort: true },
    { method: "GET" },
    { foreign: true },
    { query: "?overwrite=true" },
  ]) {
    const f = fixture();
    const r = await f.run(options);
    assert.ok(r.status >= 400);
    assert.equal(f.calls.length, 0);
  }
  const readonly = fixture();
  readonly.ctx.readOnly = true;
  assert.equal((await readonly.run()).status, 501);
  assert.equal(readonly.calls.length, 0);
  const f = fixture();
  assert.equal((await f.run()).status, 200);
  assert.equal((await f.run()).status, 200);
  assert.equal(f.calls.length, 2);
});
