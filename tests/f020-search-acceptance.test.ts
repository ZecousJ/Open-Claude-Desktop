/** F020 actual isolated Store/native search callback/REST and pinned original readers.
 * No account, SDK, model, network, UI or full native bootstrap execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import ts from "typescript";
import {
  modelPreferenceFeedbackInput,
  modelPreferenceFeedbackOutput,
  modelPreferenceFeedbackRules,
} from "../scripts/official-ui-model-preference-feedback.mjs";
// @ts-expect-error Build-time JavaScript helper.
import { hostMemoryControlsRules } from "../scripts/official-ui-host-memory-controls.mjs";
import { Store } from "../electron/store/store";
import { searchLocalConversations } from "../electron/conversations/history-search";
import { isDeviceExecutionCopy } from "../shared/chat-devices-api";
import { conversationSearchRoute } from "../electron/official-ui/api/conversation-search";
import { historyListRoute } from "../electron/official-ui/api/history-list";
import { conversationAliases } from "../electron/official-ui/api/conversations";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
const owner = "synthetic-f020",
  page = "00000000-0000-4000-8000-000000000020";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n + 100).padStart(12, "0")}`;
const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const json = (x: any) => JSON.parse(JSON.stringify(x));
function functionSource(source: string, name: string) {
  let found: any;
  const ast = ts.createSourceFile(
    "original.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  function walk(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    ts.forEachChild(n, walk);
  }
  walk(ast);
  assert.ok(found, name);
  return { ast, node: found, source: found.getText(ast) };
}
function nativeSearch(store: Store) {
  const source = fs.readFileSync("electron/app/ipc-register.ts", "utf8");
  const ast = ts.createSourceFile(
    "ipc-register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let arrow: any;
  function walk(n: ts.Node) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === "handle" &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text === "searchConversations"
    )
      arrow = n.arguments[1];
    ts.forEachChild(n, walk);
  }
  walk(ast);
  assert.ok(arrow);
  const compiled = ts.transpileModule(
    `export const invoke=${arrow.getText(ast)};`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const context = {
    exports: {},
    searchLocalConversations,
    isDeviceExecutionCopy,
    mainState: { store },
  };
  vm.runInNewContext(compiled, context);
  return (context.exports as any).invoke;
}
function seed(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: id(i),
    mode: "chat",
    title: `broad ${i} 中文🧪`,
    createdAt: 1000 + i,
    updatedAt: 2000 - i,
    providerId: "synthetic",
    model: "synthetic",
    pinned: false,
    archived: false,
    turns: [
      {
        id: `turn-${i}`,
        status: "completed",
        createdAt: 1000,
        prompt: `Body rare-${i} 中文🧪`,
        items: [
          { id: `answer-${i}`, type: "agentMessage", text: `Answer ${i}` },
        ],
        attachments: [],
      },
    ],
  })) as any[];
}
function fixture(t: any, n = 61) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f020-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let store = new Store(root);
  store.conversations = seed(n);
  store.flush();
  let active = true,
    generation = {},
    effect = "",
    calls = 0;
  let sourceOverride: any;
  const scope = newAdapterScope(owner, undefined, generation);
  inAdapterScope(scope, () => conversationAliases.restore(page, id(0)));
  const ctx: any = {
    readOnly: true,
    account: () => ({ id: owner }),
    sessionIdentity: () => generation,
    isCurrent: () => active,
    listConversations: async () =>
      structuredClone(
        store.conversations.filter((c) => !isDeviceExecutionCopy(c)),
      ),
    call: async (name: string, query: string, options: any) => {
      assert.equal(name, "searchConversations");
      calls++;
      if (effect === "throw") throw Error("private source detail");
      if (effect === "retire") generation = {};
      return sourceOverride === undefined
        ? nativeSearch(store)(query, options)
        : sourceOverride;
    },
  };
  async function run(
    body: any = { query: "broad", n: 50, target_snippet_size: 200 },
    org = organizationUuid(owner),
  ) {
    const p = `/api/organizations/${org}/conversation/search/v2`;
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: "POST", url: p, headers: {} });
    let status = 0,
      data: any;
    const res: any = {
      writeHead: (s: number) => (status = s),
      end: (b: string) => (data = JSON.parse(b)),
    };
    assert.equal(
      await inAdapterScope(scope, () =>
        conversationSearchRoute(req, res, p, ctx),
      ),
      true,
    );
    return { status, data };
  }
  async function history(offset: number) {
    const p = `/api/organizations/${organizationUuid(owner)}/chat_conversations_v2`;
    const url = new URL(
      p + `?limit=30&offset=${offset}`,
      "http://fixture.invalid",
    );
    let status = 0,
      data: any;
    const res: any = {
      writeHead: (s: number) => (status = s),
      end: (b: string) => (data = JSON.parse(b)),
    };
    await inAdapterScope(scope, () =>
      historyListRoute({ method: "GET" } as any, res, p, url, ctx),
    );
    return { status, data };
  }
  return {
    run,
    history,
    ctx,
    get store() {
      return store;
    },
    reopen() {
      store.flush();
      store = new Store(root);
    },
    setEffect(v: string) {
      effect = v;
    },
    setSource(v: any) {
      sourceOverride = v;
    },
    get calls() {
      return calls;
    },
    native: () => nativeSearch(store),
    scope,
  };
}
function original(t: any) {
  const base = path.resolve(
    process.env.CLAUDEX_F020_RESOURCES ?? "build/official-ui/ui/assets/v1",
  );
  const files = [
    "shared-0-BgsOqC85.js",
    "shared-39-BVbIfnmZ.js",
    "shared-m-1-Nm0kn4Ee.js",
  ];
  if (files.some((f) => !fs.existsSync(path.join(base, f)))) {
    t.skip(
      "Pinned original F020 reader resources required; Store/route tests still execute separately",
    );
    return;
  }
  const sources = files.map((f) => fs.readFileSync(path.join(base, f), "utf8"));
  for (const rule of hostMemoryControlsRules.filter((rule: { file: string }) => rule.file === files[0]).reverse())
    sources[0] = sources[0].replace(rule.after, () => rule.before);
  if (sha(sources[0]) === modelPreferenceFeedbackOutput) {
    for (const rule of [...modelPreferenceFeedbackRules].reverse()) {
      assert.equal(sources[0].split(rule.after).length, 2);
      sources[0] = sources[0].replace(rule.after, rule.before);
    }
    assert.equal(sha(sources[0]), modelPreferenceFeedbackInput);
  }
  const expected = [
    "9a15e991acb7930e5e25b15a453f285cda7c41a98539ed651d154c190da4ca74",
    "659546a7a3b1393dfe0d7dce42094cb7a540774ddcdf947ebde3654e279e1156",
    "35709256161ff9ce70f2c06409e7409be97ec3d244a105be9a3af44c53e8df63",
  ];
  sources.forEach((s, i) => assert.equal(sha(s), expected[i]));
  const xp = vm.runInNewContext(`(${functionSource(sources[0], "Xp").source})`);
  const gU = vm.runInNewContext(`(${functionSource(sources[2], "gU").source})`);
  const tu = functionSource(sources[1], "Tu");
  let request: any;
  function walk(n: ts.Node) {
    if (
      ts.isObjectLiteralExpression(n) &&
      n.getText(tu.ast) ===
        "{ query: ee, n: 50, enabled: te, showsOwnError: !0 }"
    )
      request = n;
    ts.forEachChild(n, walk);
  }
  walk(tu.node);
  assert.ok(request);
  const options = vm.runInNewContext(`(${request.getText(tu.ast)})`, {
    ee: "broad",
    te: true,
  });
  assert.equal(options.n, 50);
  const gt = functionSource(sources[0], "GT").source;
  assert.match(gt, /return jg\(h.path, w\)/);
  assert.doesNotMatch(gt, /getNextPageParam|cursor/);
  return { xp, gU, options };
}
test("actual 61-record Store accepts the original top-50 request and preserves stable alias/read-only state", async (t) => {
  const f = fixture(t);
  const before = json(f.store.conversations);
  const r = await f.run();
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 50);
  assert.equal(r.data.data[0].conversation.uuid, page);
  assert.equal(r.data.data[49].conversation.uuid, id(49));
  assert.equal(
    new Set(r.data.data.map((x: any) => x.conversation.uuid)).size,
    50,
  );
  assert.deepEqual(json(f.store.conversations), before);
  assert.equal("cursor" in r.data, false);
  const small = await f.run({ query: "broad", n: 20 });
  assert.equal(small.status, 200);
  assert.equal(small.data.data.length, 20);
});
test("native eligibility excludes 50 newer incognito matches and execution copies before applying the existing cap", async (t) => {
  const f = fixture(t);
  const hidden = seed(50).map((c, i) => ({
    ...c,
    id: `private-${i}`,
    updatedAt: 10000 + i,
    incognito: true,
  }));
  const copies = seed(50).map((c, i) => ({
    ...c,
    id: `copy-${i}`,
    updatedAt: 20000 + i,
    deviceChatOrigin: { conversationId: "inert" },
  }));
  f.store.conversations.unshift(...hidden, ...copies);
  f.store.flush();
  const hits = f.native()("broad", {
    mode: "chat",
    includeArchived: true,
    limit: 50,
  }).results;
  assert.equal(hits.length, 50);
  assert.ok(
    hits.every(
      (h: any) =>
        !h.conversationId.startsWith("private-") &&
        !h.conversationId.startsWith("copy-"),
    ),
  );
  const r = await f.run();
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 50);
  assert.doesNotMatch(JSON.stringify(r), /private-|copy-/);
});
test("requests above source capacity still refuse at a full cap, while uncapped n200 and no-result remain truthful", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run({ query: "broad", n: 200 })).status, 413);
  assert.equal((await f.run({ query: "broad", n: 51 })).status, 413);
  f.store.conversations.splice(4);
  let r = await f.run({ query: "broad", n: 200 });
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 4);
  r = await f.run({ query: "no-match", n: 50 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.data, []);
});
test("fresh Store content is searchable after flush and reopen; source errors and account retirement do not masquerade as empty", async (t) => {
  const f = fixture(t, 4);
  assert.equal(
    (await f.run({ query: "newneedle", n: 50 })).data.data.length,
    0,
  );
  f.store.conversations[2].turns[0].items[0].text = "newneedle 中文🧪";
  f.reopen();
  const r = await f.run({ query: "newneedle", n: 50 });
  assert.equal(r.status, 200);
  assert.equal(r.data.data[0].conversation.uuid, id(2));
  assert.match(r.data.data[0].matched_snippet.text, /newneedle 中文🧪/);
  f.setEffect("throw");
  assert.equal((await f.run()).status, 503);
  assert.doesNotMatch(JSON.stringify(await f.run()), /private source detail/);
  f.setEffect("retire");
  const retired = await f.run();
  assert.equal(retired.status, 409);
  assert.equal(retired.data.data, undefined);
});
test("foreign, duplicate and unknown results stay rejected; capped hidden remote hits cannot become an empty success", async (t) => {
  for (const kind of ["foreign", "duplicate", "unknown", "hidden"]) {
    const f = fixture(t, 4);
    let results = f.native()("broad", { mode: "chat", limit: 50 }).results;
    if (kind === "foreign" || kind === "unknown")
      results[0].conversationId = kind + "-not-owned";
    if (kind === "duplicate") results.push({ ...results[0] });
    if (kind === "hidden") {
      f.store.conversations = seed(50).map((c) => ({ ...c, incognito: true }));
      results = seed(50).map((c) => ({
        conversationId: c.id,
        mode: "chat",
        title: c.title,
        archived: false,
        updatedAt: c.updatedAt,
      }));
    }
    f.setSource({ results });
    const r = await f.run();
    assert.equal(r.status, kind === "hidden" ? 413 : 503, kind);
    assert.equal(r.data.data, undefined);
  }
  for (const privateCount of [30, 31]) {
    const scoped = fixture(t, 50);
    const results = scoped.native()("broad", {
      mode: "chat",
      limit: 50,
    }).results;
    scoped.store.conversations.forEach((c, i) => {
      c.incognito = i < privateCount;
    });
    scoped.setSource({ results });
    const r = await scoped.run({ query: "broad", n: 20 });
    assert.equal(r.status, privateCount === 30 ? 200 : 413);
    if (privateCount === 30) assert.equal(r.data.data.length, 20);
    else assert.equal(r.data.data, undefined);
  }
  const f = fixture(t);
  assert.equal((await f.run(undefined, organizationUuid("other"))).status, 404);
  assert.equal(f.calls, 0);
});
test("original top-n reader and separate history next-page function consume actual Store results without duplicate IDs", async (t) => {
  const o = original(t);
  if (!o) return;
  const f = fixture(t);
  const r = await f.run({
    query: o.options.query,
    n: o.options.n,
    target_snippet_size: 200,
  });
  assert.equal(r.status, 200);
  const first = o.xp(r.data.data[0]);
  assert.equal(first.uuid, page);
  assert.equal(first.name, "broad 0 中文🧪");
  const pages = [];
  for (const off of [0, 30, 60]) {
    const p = await f.history(off);
    assert.equal(p.status, 200);
    pages.push(p.data);
    assert.equal(o.gU(30)(p.data, pages), off < 60 ? off + 30 : undefined);
  }
  const ids = pages.flatMap((p) => p.data.map((x: any) => x.uuid));
  assert.equal(ids.length, 61);
  assert.equal(new Set(ids).size, 61);
  assert.equal(ids[0], page);
});
