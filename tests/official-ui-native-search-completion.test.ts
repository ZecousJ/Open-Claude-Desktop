/** Original descriptor producer + real native SSE; isolated storage, no model calls. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Readable, Writable } from "node:stream";
import { createNativeRestCompletionRoute } from "../electron/official-ui/api/native-rest-completion";
import { createRestCompletionRoute } from "../electron/official-ui/api/rest-completion";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { organizationUuid } from "../electron/official-ui/api/context";

const roots: string[] = [];
after(async () => {
  await new Promise((r) => setTimeout(r, 600));
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
const id = "11111111-1111-4111-8111-111111111111";
const human = "22222222-2222-4222-8222-222222222222",
  assistant = "33333333-3333-4333-8333-333333333333";
const descriptor = { type: "web_search_v0", name: "web_search" };
const sourcePath =
  ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/shared-4-Kt-jV-IU.js";
function originalProducers() {
  const source = fs.readFileSync(sourcePath, "utf8"),
    ast = ts.createSourceFile(
      "ui.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
  let blocked = false;
  const context: any = {
    CX: () => [],
    il: () => [],
    RS: () => ({ blocksMcp: false, blocksWebSearch: blocked }),
    $t: (f: Function) => f({ IframeParentTools: [], integrationName: null }),
    TI: (f: Function) => f({ active: [] }),
    ib: () => [],
    Rq: () => ({ tools: [] }),
    YF: () => false,
    n0: () => false,
    vQ: () => new Set(),
    Iy: () => [],
    Iq: () => () => false,
    Ar: () => false,
    b7: (f: Function) => f,
    fU: () => [],
    jQ: [],
    G9: new Set(),
    hZ: () => [],
    YR: () => ({ value: false }),
    zZ: () => false,
    Ll: () => ({ hideAskUserInput: false }),
    k5: {},
    WU: new Set(),
    bB: [],
    EZ: {},
  };
  for (const name of ["bN", "HK"]) {
    const node = ast.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    assert.ok(node, `Original ${name} producer exists`);
    vm.runInNewContext(node.getText(ast), context);
  }
  return {
    blocked: (value: boolean) => {
      blocked = value;
    },
    produce: (name: string, enabled: boolean) =>
      JSON.parse(
        JSON.stringify(
          name === "bN"
            ? context.bN()({ enabled_web_search: enabled })
            : context.HK({ enabled_web_search: enabled })(),
        ),
      ),
  };
}
function fixture(
  options: {
    existing?: boolean;
    search?: boolean;
    readOnly?: boolean;
    strict?: boolean;
    web?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-search-"));
  roots.push(root);
  let identity = {},
    policy = true,
    capability: string | undefined = "native",
    protocol = "responses";
  let policyHook: (() => void) | undefined;
  let c: any = options.existing
    ? {
        id,
        mode: "chat",
        title: "Existing",
        providerId: "p",
        model: "m",
        createdAt: 1,
        updatedAt: 1,
        webSearch: options.search,
        turns: [
          {
            id: "seed",
            prompt: "old",
            createdAt: 1,
            status: "completed",
            attachments: [],
            items: [{ id: "answer", type: "agentMessage", text: "old answer" }],
          },
        ],
      }
    : undefined;
  const sends: any[] = [],
    versions: any[] = [],
    calls: string[] = [];
  let reads = 0;
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    readOnly: options.readOnly,
    strictActionSemantics: options.strict,
    settings: () => ({
      activeProviderId: "p",
      providers: [{ id: "p", model: "m", models: [], protocol }],
    }),
    modelCatalog: async () => ({
      items: [{ id: "m", efforts: [], webSearch: capability }],
    }),
    snapshot: async () => ({
      projects: [],
      conversations: c ? [structuredClone(c)] : [],
    }),
    loadConversation: async () => {
      reads++;
      return c && structuredClone(c);
    },
    onEvent: () => () => {},
    call: async (name: string, ...args: any[]) => {
      calls.push(name);
      if (name === "clientPolicy") {
        policyHook?.();
        return { webSearch: policy };
      }
      if (name === "setConversationResearch") {
        c.research = args[1];
        c.webSearch = true;
        return structuredClone(c);
      }
      if (name === "send") {
        const input = args[0];
        sends.push(structuredClone(input));
        c = {
          ...c,
          id,
          mode: "chat",
          title: "Reply",
          providerId: "p",
          model: "m",
          createdAt: 1,
          updatedAt: 2,
          webSearch: input.webSearch ?? c?.webSearch,
          turns: [
            ...(c?.turns ?? []),
            {
              id: "sent-" + sends.length,
              prompt: input.text,
              createdAt: 2,
              status: "completed",
              attachments: [],
              items: [{ id: "reply", type: "agentMessage", text: "answer" }],
            },
          ],
        };
      } else {
        assert.ok(["retryResponse", "editPrompt"].includes(name), name);
        versions.push([name, ...args]);
        c.turns.push({
          id: "version",
          prompt: name === "retryResponse" ? "old" : args[2],
          createdAt: 2,
          status: "completed",
          attachments: [],
          items: [
            { id: "reply", type: "agentMessage", text: "version answer" },
          ],
        });
      }
      return structuredClone(c);
    },
  };
  const scope = newAdapterScope("owner", root, identity),
    route = options.web
      ? createRestCompletionRoute(ctx)
      : createNativeRestCompletionRoute(ctx, { pollMs: 1, deadlineMs: 1000 });
  return {
    sends,
    versions,
    calls,
    ctx,
    get c() {
      return c;
    },
    get reads() {
      return reads;
    },
    policy: (value: boolean) => {
      policy = value;
    },
    capability: (value?: string) => {
      capability = value;
    },
    protocol: (value: string) => {
      protocol = value;
    },
    policyHook: (fn: () => void) => {
      policyHook = fn;
    },
    retire: () => {
      identity = {};
    },
    async run(
      patch: Record<string, unknown> = {},
      endpoint = "completion",
      org = "owner",
    ) {
      const body = {
        prompt: "hello",
        model: "m",
        tools: [descriptor],
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: "messages",
        completion_request_id: "44444444-4444-4444-8444-444444444444",
        turn_message_uuids: {
          human_message_uuid: human,
          assistant_message_uuid: assistant,
        },
        ...(options.existing
          ? {}
          : {
              create_conversation_params: {
                name: "",
                model: "m",
                include_conversation_preferences: true,
                is_temporary: false,
              },
            }),
        ...patch,
      };
      const p = `/api/organizations/${organizationUuid(org)}/chat_conversations/${id}/${endpoint}`;
      const req: any = Object.assign(
        Readable.from([Buffer.from(JSON.stringify(body))]),
        {
          method: "POST",
          url: p,
          headers: { "content-type": "application/json" },
        },
      );
      let status = 0,
        chunks: Buffer[] = [];
      const res: any = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
      res.writeHead = (value: number) => {
        status = value;
        res.headersSent = true;
        return res;
      };
      const finished = new Promise<void>((resolve, reject) => {
        res.once("finish", resolve);
        res.once("error", reject);
      });
      await inAdapterScope(scope, () =>
        route(req, res, p, new URL(p, "http://localhost")),
      );
      await finished;
      return { status, text: Buffer.concat(chunks).toString() };
    },
  };
}

test(
  "both actual original producers emit the exact native descriptor only when enabled and unblocked",
  { skip: !fs.existsSync(sourcePath) },
  () => {
    const original = originalProducers();
    for (const name of ["bN", "HK"]) {
      assert.deepEqual(
        original
          .produce(name, true)
          .filter((v: any) => v.type === "web_search_v0"),
        [descriptor],
      );
      assert.deepEqual(
        original
          .produce(name, false)
          .filter((v: any) => v.type === "web_search_v0"),
        [],
      );
      original.blocked(true);
      assert.deepEqual(
        original
          .produce(name, true)
          .filter((v: any) => v.type === "web_search_v0"),
        [],
      );
      original.blocked(false);
    }
  },
);

test("verified native search descriptor reaches first send once and produces a terminal SSE response", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.status, 200);
  assert.match(result.text, /event: message_stop/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].webSearch, true);
  assert.equal(f.c.webSearch, true);
  await f.run();
  assert.equal(f.sends.length, 1, "same receipt never submits again");
});

test(
  "actual original producer search entries reach native SSE without allowing their unrelated tools",
  { skip: !fs.existsSync(sourcePath) },
  async () => {
    const original = originalProducers();
    for (const name of ["bN", "HK"]) {
      const tools = original.produce(name, true),
        f = fixture();
      assert.equal(
        (
          await f.run({
            tools: tools.filter((v: any) => v.type === "web_search_v0"),
          })
        ).status,
        200,
      );
      assert.equal(f.sends[0].webSearch, true);
      const unsupported = fixture();
      assert.equal((await unsupported.run({ tools })).status, 501);
      assert.equal(unsupported.sends.length, 0);
    }
  },
);

test("native descriptor is exact, single and closed to extra tool fields", async () => {
  for (const tools of [
    [{ ...descriptor, name: "other" }],
    [{ ...descriptor, type: "web_search" }],
    [{ ...descriptor, input_schema: {} }],
    [descriptor, descriptor],
    [descriptor, { type: "artifacts_v0", name: "artifacts" }],
  ]) {
    const f = fixture();
    assert.equal((await f.run({ tools })).status, 501);
    assert.equal(f.calls.length, 0);
    assert.equal(f.reads, 0);
  }
});

test("strict Web and restricted hosts never accept native search descriptors", async () => {
  for (const options of [{ web: true }, { readOnly: true }, { strict: true }]) {
    const f = fixture(options);
    assert.equal((await f.run()).status, 501);
    assert.equal(f.calls.length, 0);
    assert.equal(f.reads, 0);
  }
});

test("native search checks policy, catalog support and Responses protocol before send", async () => {
  for (const mode of ["policy", "none", "missing", "chat"]) {
    const f = fixture();
    if (mode === "policy") f.policy(false);
    if (mode === "none") f.capability("none");
    if (mode === "missing") f.capability(undefined);
    if (mode === "chat") f.protocol("chat");
    const result = await f.run();
    assert.equal(result.status, mode === "policy" ? 403 : 400, result.text);
    assert.equal(f.sends.length, 0);
  }
});

test("existing search is inherited, an off setting is never silently enabled and absence never turns it off", async () => {
  const enabled = fixture({ existing: true, search: true });
  assert.match((await enabled.run()).text, /event: message_stop/);
  assert.equal(enabled.sends[0].webSearch, undefined);
  assert.equal(enabled.c.webSearch, true);
  const disabled = fixture({ existing: true, search: false });
  assert.equal((await disabled.run()).status, 409);
  assert.equal(disabled.calls.length, 0);
  const absent = fixture({ existing: true, search: true });
  assert.match((await absent.run({ tools: [] })).text, /event: message_stop/);
  assert.equal(absent.sends[0].webSearch, undefined);
  assert.equal(absent.c.webSearch, true);
});

test("search descriptor preserves retry and edit operations instead of creating ordinary turns", async () => {
  const retry = fixture({ existing: true, search: true });
  const result = await retry.run(
    {
      prompt: "",
      parent_message_uuid: "seed:user",
      turn_message_uuids: { assistant_message_uuid: assistant },
    },
    "retry_completion",
  );
  assert.match(result.text, /event: message_stop/);
  assert.equal(retry.sends.length, 0);
  assert.equal(retry.versions[0][0], "retryResponse");
  const edit = fixture({ existing: true, search: true });
  assert.match(
    (
      await edit.run({
        parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      })
    ).text,
    /event: message_stop/,
  );
  assert.equal(edit.sends.length, 0);
  assert.equal(edit.versions[0][0], "editPrompt");
});

test("wrong organization and account retirement cannot dispatch search", async () => {
  const foreign = fixture();
  assert.equal((await foreign.run({}, "completion", "other")).status, 404);
  assert.equal(foreign.calls.length, 0);
  const retired = fixture();
  retired.policyHook(retired.retire);
  assert.equal((await retired.run()).status, 409);
  assert.equal(retired.sends.length, 0);
});

test("a later saved Off or policy restriction is checked again inside queued send preparation", async () => {
  for (const mode of ["off", "policy"]) {
    const f = fixture({ existing: true, search: true });
    let reads = 0;
    f.policyHook(() => {
      if (++reads === 2) {
        if (mode === "off") f.c.webSearch = false;
        else f.policy(false);
      }
    });
    const result = await f.run();
    assert.match(result.text, /event: error/);
    assert.equal(f.sends.length, 0);
    await f.run();
    assert.equal(f.sends.length, 0, "failed request cannot replay");
  }
});

test("a completed search receipt stays replayable after a later saved Off", async () => {
  const f = fixture();
  assert.match((await f.run()).text, /event: message_stop/);
  f.c.webSearch = false;
  const replay = await f.run();
  assert.match(replay.text, /event: message_stop/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.c.webSearch, false);
});


test("original REST Research command and advanced creation reach Research without changing the prompt", async () => {
  const fresh = fixture();
  const created = await fresh.run({ prompt: "/deep-research investigate", tools: [], create_conversation_params: {
    name: "", model: "m", include_conversation_preferences: true, is_temporary: false, compass_mode: "advanced",
  } });
  assert.equal(created.status, 200);
  assert.equal(fresh.sends[0].text, "/deep-research investigate");
  assert.equal(fresh.sends[0].research, true);
  const existing = fixture({ existing: true });
  const result = await existing.run({ prompt: "/deep-research  investigate", tools: [] });
  assert.equal(result.status, 200);
  assert.equal(existing.sends[0].research, true);
  assert.ok(existing.calls.includes("setConversationResearch"));
  const blocked = fixture();
  blocked.policy(false);
  const refused = await blocked.run({ prompt: "/deep-research investigate", tools: [] });
  assert.equal(refused.status, 403);
  assert.equal(blocked.sends.length, 0);
  const invalid = fixture();
  const bad = await invalid.run({ tools: [], create_conversation_params: { name: "", model: "m", include_conversation_preferences: true, is_temporary: false, compass_mode: "light" } });
  assert.equal(bad.status, 501);
  assert.equal(invalid.sends.length, 0);
});
