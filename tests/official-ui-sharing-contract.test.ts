/** Synthetic adapter contract tests. Never contact an external sharing service. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { sharingRoute } from "../electron/official-ui/api/sharing";
import { organizationUuid } from "../electron/official-ui/api/context";
function fixture() {
  let owner = "a",
    identity = 1,
    active = true;
  let share: any = {
    id: "snapshot",
    kind: "conversation",
    sourceKey: "chat",
    title: "Synthetic",
    url: "https://example.test/s/token",
    createdAt: 1,
    snapshotAt: 1,
    status: "active",
    access: "link",
    invites: [],
  };
  let fail = "",
    retire = "",
    absent = false,
    nullAccess = false,
    ignoreAccess = false;
  const calls: string[] = [];
  const ctx: any = {
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => identity,
    isCurrent: () => active,
    loadConversation: async () =>
      absent
        ? undefined
        : { id: "chat", turns: [{ id: "turn", status: "completed" }] },
    call: async (name: string, ...args: any[]) => {
      calls.push(name);
      if (retire === name) identity++;
      if (fail === name) throw Error("private-key /secret upstream");
      if (name === "sharingStatus") return { conversations: true };
      if (name === "conversationShare") return share;
      if (name === "hostedShares") return [share];
      if (name === "shareConversation") return share;
      if (name === "setShareAccess") {
        if (nullAccess) return null;
        if (!ignoreAccess) share = { ...share, access: args[1] };
        return share;
      }
      if (name === "inviteToShare") {
        share = { ...share, invites: [...share.invites, args[1]] };
        return { share, mailed: false, added: true };
      }
      throw Error(name);
    },
  };
  async function run(
    path = "share",
    body: any = {},
    method = path === "share" ? "POST" : "GET",
    org = organizationUuid("a"),
  ) {
    const p = path.startsWith("/")
      ? path
      : `/api/organizations/${org}/chat_conversations/chat/${path}`;
    const bytes = typeof body === "string" ? body : JSON.stringify(body);
    const req: any = Readable.from([bytes]);
    req.method = method;
    req.url = p;
    req.headers = {};
    let status = 0,
      data: any;
    const res: any = {
      writeHead: (code: number) => (status = code),
      end: (text: string) => {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      },
    };
    const handled = await sharingRoute(req, res, p, ctx);
    return { handled, status, data };
  }
  return {
    ctx,
    calls,
    run,
    set: (v: any) => {
      if (v.fail) fail = v.fail;
      if (v.retire) retire = v.retire;
      if (v.absent) absent = true;
      if (v.nullAccess) nullAccess = true;
      if (v.ignoreAccess) ignoreAccess = true;
      if (v.share) share = { ...share, ...v.share };
      if (v.owner !== undefined) owner = v.owner;
      if (v.active !== undefined) active = v.active;
    },
  };
}
test("valid public creation returns hosted snapshot; latest message selector stays supported", async () => {
  const f = fixture();
  const r = await f.run("share", {
    visibility: "public",
    last_message_uuid: "turn:assistant",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.uuid, "snapshot");
  assert.deepEqual(f.calls, ["shareConversation"]);
});
test("malformed JSON, nonobjects, invalid visibility and email reject before mutation", async () => {
  for (const body of [
    "{",
    "null",
    "[]",
    { visibility: "publci" },
    { emails: "a@example.test" },
    { emails: [42] },
    { emails: ["invalid"] },
    { last_message_uuid: 3 },
  ]) {
    const f = fixture();
    assert.equal((await f.run("share", body)).status, 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.run("share", "x".repeat(65537))).status, 413);
  assert.equal(f.calls.length, 0);
});
test("historical and unknown end selectors never publish the entire conversation", async () => {
  for (const id of ["earlier:assistant", "turn:user", "unknown"]) {
    const f = fixture();
    assert.equal((await f.run("share", { last_message_uuid: id })).status, 409);
    assert.deepEqual(f.calls, []);
  }
});
test("method, org, signed-out, read-only, stale, missing owned conversation block", async () => {
  for (const kind of [
    "method",
    "org",
    "logout",
    "readonly",
    "stale",
    "absent",
  ]) {
    const f = fixture();
    if (kind === "logout") f.set({ owner: "" });
    if (kind === "readonly") f.ctx.readOnly = true;
    if (kind === "stale") f.set({ active: false });
    if (kind === "absent") f.set({ absent: true });
    const r = await f.run(
      "share",
      {},
      kind === "method" ? "PUT" : "POST",
      organizationUuid(kind === "org" ? "b" : "a"),
    );
    assert.ok(r.status >= 400);
    assert.equal(f.calls.length, 0);
  }
});
test("private request with null access outcome never reports stale public success", async () => {
  const f = fixture();
  f.set({ nullAccess: true });
  const r = await f.run("share", { visibility: "private" });
  assert.equal(r.status, 409);
  assert.equal(r.data.uuid, undefined);
  assert.deepEqual(f.calls, ["shareConversation", "setShareAccess"]);
});
test("private invite-only access and invitations verified from result", async () => {
  const f = fixture();
  f.set({ share: { access: "invited" } });
  const r = await f.run("share", {
    visibility: "private",
    emails: ["a@example.test"],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.visibility, "invite_only");
  assert.deepEqual(f.calls, ["shareConversation", "inviteToShare"]);
});
test("access mismatch cannot be declared successful", async () => {
  const f = fixture();
  f.set({ ignoreAccess: true });
  assert.equal((await f.run("share", { visibility: "private" })).status, 503);
});
test("read and mutation failures are sanitized, never empty-success or false404", async () => {
  for (const [path, fail] of [
    ["latest", "sharingStatus"],
    ["latest", "conversationShare"],
    ["shares", "conversationShare"],
    ["share_access", "conversationShare"],
    ["share", "shareConversation"],
    ["share", "setShareAccess"],
    ["share", "inviteToShare"],
    [`/api/organizations/${organizationUuid("a")}/shares`, "hostedShares"],
    ["/api/__claudex/share-url/snapshot", "hostedShares"],
  ]) {
    const f = fixture();
    f.set({ fail });
    const r = await f.run(path, {
      visibility: "private",
      emails: ["a@example.test"],
    });
    assert.equal(r.status, 503, fail);
    assert.doesNotMatch(JSON.stringify(r.data), /private-key|secret/);
  }
});
test("retirement between any asynchronous mutations prevents following dispatch", async () => {
  for (const at of ["shareConversation", "setShareAccess", "inviteToShare"]) {
    const f = fixture();
    f.set({ retire: at });
    const r = await f.run("share", {
      visibility: "private",
      emails: ["a@example.test", "b@example.test"],
    });
    assert.equal(r.status, 409);
    assert.equal(f.calls.at(-1), at);
  }
});
test("inventory methods/org and inactive share address stay guarded", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.run(
        `/api/organizations/${organizationUuid("b")}/shares`,
        {},
        "GET",
      )
    ).status,
    404,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run("/api/__claudex/share-url/snapshot", {}, "POST")).status,
    405,
  );
  f.set({ share: { status: "disabled" } });
  assert.equal(
    (await f.run("/api/__claudex/share-url/snapshot", {}, "GET")).status,
    404,
  );
});
test("fresh ownership and end selection rechecked after request body parsing", async () => {
  for (const mode of ["changed", "removed"]) {
    const f = fixture();
    let loads = 0;
    f.ctx.loadConversation = async () =>
      ++loads === 1
        ? { id: "chat", turns: [{ id: "turn", status: "completed" }] }
        : mode === "removed"
          ? undefined
          : { id: "chat", turns: [{ id: "later", status: "completed" }] };
    const r = await f.run("share", { last_message_uuid: "turn:assistant" });
    assert.equal(r.status, mode === "removed" ? 404 : 409);
    assert.equal(f.calls.length, 0);
  }
});
test("invalid access or first invite response never dispatches remaining invitations", async () => {
  for (const at of ["setShareAccess", "inviteToShare"]) {
    const f = fixture();
    const call = f.ctx.call;
    f.ctx.call = async (name: string, ...args: any[]) => {
      const result = await call(name, ...args);
      if (name === at)
        return at === "inviteToShare"
          ? { share: { ...result.share, status: "disabled" } }
          : { ...result, status: "disabled" };
      return result;
    };
    const r = await f.run("share", {
      visibility: "private",
      emails: ["a@example.test", "b@example.test"],
    });
    assert.equal(r.status, 503);
    assert.equal(f.calls.at(-1), at);
    assert.equal(
      f.calls.filter((name) => name === "inviteToShare").length,
      at === "setShareAccess" ? 0 : 1,
    );
  }
});
