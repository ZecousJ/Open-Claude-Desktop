/** Inert native-route calls only: no store, IPC, account, or real deletion. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { bulkDeleteRoute } from "../electron/official-ui/api/bulk-delete";
import { conversationsRoute } from "../electron/official-ui/api/conversations";
import { organizationUuid } from "../electron/official-ui/api/context";
function fixture() {
  let owner = "a",
    activation = 1,
    current = true,
    retireAt = "",
    fail = "",
    reads = 0;
  const calls: string[] = [],
    available = new Set(["first", "second", "third"]);
  const ctx: any = {
    readOnly: false,
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => activation,
    isCurrent: () => current,
    loadConversation: async (id: string) => {
      reads++;
      if (retireAt === "read") activation++;
      return available.has(id) ? { id, mode: "chat" } : undefined;
    },
    call: async (name: string, id: string) => {
      assert.equal(name, "deleteConversation");
      calls.push(id);
      if (retireAt === "call") activation++;
      if (id === fail) throw Error("private backend details");
      return undefined;
    },
  };
  async function run(
    body: any = { conversation_uuids: ["first", "second"] },
    options: {
      org?: string;
      query?: string;
      raw?: Buffer;
      method?: string;
      resolve?: (id: string) => string;
    } = {},
  ) {
    const path = `/api/organizations/${options.org ?? organizationUuid("a")}/chat_conversations/delete_many`,
      url = new URL(path + (options.query ?? ""), "http://inert.invalid");
    const req: any = Readable.from([
      options.raw ?? Buffer.from(JSON.stringify(body)),
    ]);
    req.method = options.method ?? "POST";
    req.url = url.pathname + url.search;
    req.headers = { "content-type": "application/json" };
    let code = 0,
      result: any;
    const res: any = {
      writeHead: (n: number) => {
        code = n;
      },
      end: (b: string) => {
        result = b ? JSON.parse(b) : undefined;
      },
    };
    if (options.resolve)
      await bulkDeleteRoute(req, res, path, url, ctx, options.resolve);
    else await conversationsRoute(req, res, path, url, ctx);
    return { code, body: result };
  }
  return {
    ctx,
    calls,
    available,
    run,
    get reads() {
      return reads;
    },
    retire: (where: string) => {
      retireAt = where;
    },
    fail: (id: string) => {
      fail = id;
    },
    owner: (value: string) => {
      owner = value;
    },
    inactive: () => {
      current = false;
    },
  };
}
test("bulk deletion preserves exact deleted and failed IDs without retries or private error leakage", async () => {
  const f = fixture();
  f.fail("second");
  const r = await f.run({ conversation_uuids: ["first", "second", "third"] });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.deleted, ["first", "third"]);
  assert.equal(r.body.failed[0].uuid, "second");
  assert.doesNotMatch(JSON.stringify(r.body), /private backend/);
  assert.deepEqual(f.calls, ["first", "second", "third"]);
  assert.equal(f.reads, 3);
});
test("malformed, duplicate, oversized, and ignored-field batches fail before any mutation", async () => {
  for (const body of [
    {},
    { conversation_uuids: [] },
    { conversation_uuids: [1] },
    { conversation_uuids: ["first", "first"] },
    { conversation_uuids: [" first"] },
    { conversation_uuids: ["../first"] },
    { conversation_uuids: ["first"], extra: true },
    { conversation_uuids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) },
  ]) {
    const f = fixture();
    assert.equal(
      (await f.run(body)).code,
      400,
      JSON.stringify(body).slice(0, 100),
    );
    assert.deepEqual(f.calls, []);
  }
  for (const raw of [Buffer.from("{"), Buffer.from([255])]) {
    const f = fixture();
    assert.equal((await f.run(null, { raw })).code, 400);
    assert.deepEqual(f.calls, []);
  }
  const large = fixture();
  assert.equal(
    (await large.run(null, { raw: Buffer.alloc(256 * 1024 + 1, 32) })).code,
    413,
  );
  assert.deepEqual(large.calls, []);
});
test("wrong organization, readonly, unknown or foreign IDs and stale activations cause zero dispatch", async () => {
  const foreign = fixture();
  assert.equal(
    (await foreign.run(undefined, { org: organizationUuid("b") })).code,
    404,
  );
  assert.deepEqual(foreign.calls, []);
  const missing = fixture();
  assert.equal(
    (await missing.run({ conversation_uuids: ["first", "foreign"] })).code,
    404,
  );
  assert.deepEqual(missing.calls, []);
  const readonly = fixture();
  readonly.ctx.readOnly = true;
  assert.equal((await readonly.run()).code, 501);
  assert.deepEqual(readonly.calls, []);
  const retired = fixture();
  retired.retire("read");
  assert.equal((await retired.run()).code, 409);
  assert.deepEqual(retired.calls, []);
  const inactive = fixture();
  inactive.inactive();
  assert.equal((await inactive.run()).code, 409);
  assert.deepEqual(inactive.calls, []);
  const query = fixture();
  assert.equal(
    (await query.run(undefined, { query: "?retry=true" })).code,
    400,
  );
  assert.deepEqual(query.calls, []);
});
test("activation retiring after one dispatched deletion stops the batch, never retries, and reports conflict", async () => {
  const f = fixture();
  f.retire("call");
  assert.equal((await f.run()).code, 409);
  assert.deepEqual(f.calls, ["first"]);
});
test("missing, null, throwing activation identity or absent lifecycle veto fail closed", async () => {
  for (const value of [
    undefined,
    () => undefined,
    () => null,
    () => {
      throw Error("private lifecycle");
    },
  ]) {
    const f = fixture();
    f.ctx.sessionIdentity = value;
    assert.equal((await f.run()).code, 409);
    assert.deepEqual(f.calls, []);
  }
  for (const value of [
    undefined,
    () => undefined,
    () => {
      throw Error("private lifecycle");
    },
  ]) {
    const f = fixture();
    f.ctx.isCurrent = value;
    assert.equal((await f.run()).code, 409);
    assert.deepEqual(f.calls, []);
  }
});
test("Cowork task subset schema is checked but unsupported destructive semantics never fall through", async () => {
  for (const subset of [["foreign"], [1], ["first", "first"], "first"]) {
    const f = fixture();
    assert.equal(
      (
        await f.run({
          conversation_uuids: ["first"],
          delete_cowork_session_conversation_uuids: subset,
        })
      ).code,
      400,
    );
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  assert.equal(
    (
      await f.run({
        conversation_uuids: ["first"],
        delete_cowork_session_conversation_uuids: ["first"],
      })
    ).code,
    501,
  );
  assert.deepEqual(f.calls, []);
  const empty = fixture();
  assert.equal(
    (
      await empty.run({
        conversation_uuids: ["first"],
        delete_cowork_session_conversation_uuids: [],
      })
    ).code,
    200,
  );
  for (const mode of ["cowork", "code"]) {
    const task = fixture();
    task.ctx.loadConversation = async (id: string) => ({ id, mode });
    assert.equal((await task.run()).code, 501);
    assert.deepEqual(task.calls, []);
  }
});
test("unknown outcome after a simulated side effect is not retried or mislabeled deleted", async () => {
  const f = fixture();
  let effects = 0;
  f.ctx.call = async () => {
    effects++;
    throw Error("private failure after mutation");
  };
  const r = await f.run({ conversation_uuids: ["first"] });
  assert.equal(r.code, 200);
  assert.equal(effects, 1);
  assert.deepEqual(r.body.deleted, []);
  assert.equal(r.body.failed[0].uuid, "first");
  assert.match(r.body.failed[0].error, /Refresh/);
  assert.doesNotMatch(JSON.stringify(r.body), /private failure/);
});
test("duplicate, throwing, invalid and changed aliases are bounded without wrong-target calls", async () => {
  for (const resolve of [
    () => {
      throw Error("private alias");
    },
    () => null as any,
    () => "",
    () => "/private",
    () => "first",
  ]) {
    const f = fixture();
    const r = await f.run(undefined, { resolve });
    assert.ok([400, 409].includes(r.code));
    assert.deepEqual(f.calls, []);
    assert.doesNotMatch(JSON.stringify(r.body), /private alias/);
  }
  const changed = fixture();
  let resolutions = 0;
  const resolve = (id: string) => {
    resolutions++;
    return resolutions > 2 ? "third" : id;
  };
  assert.equal((await changed.run(undefined, { resolve })).code, 409);
  assert.deepEqual(changed.calls, []);
});
test("same-account reactivation and preflight source failure never dispatch", async () => {
  const f = fixture();
  let identity = {};
  f.ctx.sessionIdentity = () => identity;
  f.ctx.loadConversation = async (id: string) => {
    identity = {};
    return { id, mode: "chat" };
  };
  assert.equal((await f.run()).code, 409);
  assert.deepEqual(f.calls, []);
  const failure = fixture();
  failure.ctx.loadConversation = async () => {
    throw Error("private database");
  };
  const r = await failure.run();
  assert.equal(r.code, 503);
  assert.deepEqual(failure.calls, []);
  assert.doesNotMatch(JSON.stringify(r.body), /private database/);
});
