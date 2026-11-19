import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  bootstrapRoute,
  modelSelectorOf,
} from "../electron/official-ui/api/bootstrap";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  readModelPreference,
  writeModelPreference,
} from "../electron/official-ui/api/model-selection-preferences";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-preferences-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "a",
    session = 1,
    hook = () => {};
  let catalog: any = {
    defaultModel: "m1",
    items: [
      {
        id: "m1",
        displayName: "One",
        sort: 0,
        hidden: false,
        efforts: ["low", "high"],
        defaultEffort: "high",
      },
      { id: "m2", displayName: "Two", sort: 1, hidden: true, efforts: [] },
    ],
  };
  const settings = { providers: [], effort: "high", codeEffort: "high" };
  const ctx: any = {
    root,
    account: () => ({ id: owner }),
    stateDirectory: () => root,
    sessionIdentity: () => session,
    isCurrent: () => true,
    settings: () => settings,
    call: async () => null,
    modelCatalog: async () => {
      hook();
      if (catalog instanceof Error) throw catalog;
      return catalog;
    },
    log() {},
  };
  async function request(
    p: string,
    body: unknown,
    method: string,
    raw: boolean,
  ) {
    const req: any = Readable.from(
      body === undefined
        ? []
        : [Buffer.from(raw ? String(body) : JSON.stringify(body))],
    );
    req.method = method;
    req.headers = {};
    let status = 0,
      data: any;
    const res: any = {
      writeHead(n: number) {
        status = n;
      },
      end(v: string) {
        data = JSON.parse(v);
      },
    };
    await bootstrapRoute(req, res, p, ctx);
    return { status, data };
  }
  return {
    ctx,
    root,
    settings,
    run(
      body: unknown,
      surface = "chat",
      org = organizationUuid(owner),
      method = "PATCH",
      raw = false,
    ) {
      return request(
        `/api/organizations/${org}/model_selector_state/${surface}`,
        body,
        method,
        raw,
      );
    },
    bootstrap() {
      return request(
        `/edge-api/bootstrap/${organizationUuid(owner)}/app_start`,
        undefined,
        "GET",
        false,
      );
    },
    owner(v: string) {
      owner = v;
    },
    rotate() {
      session++;
    },
    hook(v: () => void) {
      hook = v;
    },
    catalog(v: any) {
      catalog = v;
    },
    accountDir: () => path.join(root, "official-ui", "accounts", hash(owner)),
  };
}
test("conversation pickers exclude drawing models and recover from saved drawing choices", async (t) => {
  const f = fixture(t);
  f.catalog({
    defaultModel: "gpt-image-2.5",
    items: [
      { id: "gpt-image-2.5", displayName: "gpt-image-2.5", sort: 0, isDefault: true },
      {
        id: "gpt-6-sol",
        displayName: "GPT-6 Sol",
        sort: 1,
        efforts: ["low", "high"],
        defaultEffort: "high",
      },
      { id: "gpt-6-luna", displayName: "GPT-6 Luna", sort: 2, hidden: true },
      { id: "gpt-4o-mini-tts", displayName: "GPT-4o mini TTS", sort: 3 },
    ],
  });
  for (const surface of ["chat", "code"])
    writeModelPreference(f.ctx, surface, { model: "gpt-image-2.5" });

  const { status, data } = await f.bootstrap();
  assert.equal(status, 200);
  for (const surface of data.model_selector_config) {
    assert.deepEqual(
      surface.models.map(({ id, section }: { id: string; section: string }) => [id, section]),
      [["gpt-6-sol", "main"], ["gpt-6-luna", "overflow"]],
    );
    assert.equal(
      (await f.run({ model: "gpt-image-2.5" }, surface.id)).status,
      400,
    );
  }
  assert.deepEqual(
    data.claude_ai_available_models.models.map((m: { model_id: string }) => m.model_id),
    ["gpt-6-sol", "gpt-6-luna"],
  );
  for (const state of data.model_selector_state) {
    assert.equal(state.model, "gpt-6-sol");
    assert.equal(state.selection_source, "default");
  }

  const effort = await f.run(
    { thinking: { type: "effort", effort: "low" } },
    "code",
  );
  assert.equal(effort.status, 200);
  const saved = (await f.bootstrap()).data.model_selector_state;
  const savedCode = saved.find((s: { id: string }) => s.id === "code");
  assert.equal(savedCode.model, "gpt-6-sol");
  assert.equal(savedCode.selection_source, "default");
  assert.equal(savedCode.thinking.effort, "low");
  assert.equal((await f.run({ model: null })).data.model, "gpt-6-sol");
});

test("an image-only catalog advertises no conversation models", async (t) => {
  const f = fixture(t);
  f.catalog({
    defaultModel: "gpt-image-2.5",
    items: [{ id: "gpt-image-2.5", displayName: "gpt-image-2.5", sort: 0 }],
  });
  const { status, data } = await f.bootstrap();
  assert.equal(status, 200);
  assert.deepEqual(
    data.model_selector_config,
    ["chat", "code", "cowork", "hub"].map((id) => ({ id, models: [] })),
  );
  assert.deepEqual(data.model_selector_state, []);
  assert.deepEqual(data.claude_ai_available_models.models, []);
});

test("native selection acknowledged only after atomic persistence; independent surfaces and new contexts see it", async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.settings);
  assert.equal(
    (await f.run({ model: "m2", thinking: { type: "disabled" } })).status,
    200,
  );
  assert.equal(
    (
      await f.run(
        {
          model: "m1",
          thinking: { type: "effort_and_mode", effort: "low", mode: "auto" },
        },
        "code",
      )
    ).status,
    200,
  );
  const reopened = await modelSelectorOf({ ...f.ctx }, {});
  assert.equal(reopened.state.find((s) => s.id === "chat")?.model, "m2");
  assert.equal(
    reopened.state.find((s) => s.id === "code")?.thinking.effort,
    "low",
  );
  assert.deepEqual(f.settings, before);
  assert.equal(
    fs
      .readdirSync(path.join(f.accountDir(), "model-selections"))
      .filter((n) => n.endsWith(".json")).length,
    2,
  );
});
test("account isolation works even without global scoped mode; old unowned state is not adopted", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "official-ui"), { recursive: true });
  const global = path.join(f.root, "official-ui", "model-selections.json");
  fs.writeFileSync(global, JSON.stringify({ chat: { model: "m2" } }));
  assert.deepEqual(readModelPreference(f.ctx, "chat"), {});
  await f.run({ model: "m2" });
  f.owner("b");
  assert.deepEqual(readModelPreference(f.ctx, "chat"), {});
  f.owner("a");
  assert.equal(readModelPreference(f.ctx, "chat").model, "m2");
  assert.deepEqual(JSON.parse(fs.readFileSync(global, "utf8")), {
    chat: { model: "m2" },
  });
});
test("explicit null reset overrides proven aggregate without modifying it or other surfaces", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.accountDir(), { recursive: true });
  const file = path.join(f.accountDir(), "model-selections.json");
  const old = {
    chat: { model: "m2" },
    code: { model: "m1", thinking: { type: "effort", effort: "low" } },
  };
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(readModelPreference(f.ctx, "chat").model, "m2");
  const r = await f.run({ model: null, thinking: null });
  assert.equal(r.status, 200);
  assert.equal(r.data.model, "m1");
  assert.deepEqual(readModelPreference(f.ctx, "chat"), {});
  assert.equal(readModelPreference(f.ctx, "code").model, "m1");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), old);
});
test("unknown surfaces/model/effort/options, malformed and oversized bodies fail without success", async (t) => {
  const f = fixture(t);
  for (const [body, surface] of [
    [{ model: "m1" }, "__proto__"],
    [{ model: "missing" }, "chat"],
    [{ model: "m1", thinking: { type: "effort", effort: "ultra" } }, "chat"],
    [{ model: "m2", thinking: { type: "effort", effort: "low" } }, "chat"],
    [{ fast_mode: true }, "chat"],
    [{}, "chat"],
  ] as const)
    assert.equal((await f.run(body, surface)).status, 400);
  assert.equal(
    (await f.run("{", "chat", undefined, undefined, true)).status,
    400,
  );
  assert.equal((await f.run({ model: "x".repeat(5000) })).status, 413);
  assert.deepEqual(readModelPreference(f.ctx, "chat"), {});
});
test("read-only Web, foreign org and retired activation never write", async (t) => {
  const f = fixture(t);
  f.ctx.readOnly = true;
  assert.equal((await f.run({ model: "m2" })).status, 501);
  f.ctx.readOnly = false;
  assert.equal(
    (await f.run({ model: "m2" }, "chat", organizationUuid("foreign"))).status,
    404,
  );
  f.hook(() => f.rotate());
  assert.equal((await f.run({ model: "m2" })).status, 409);
  assert.deepEqual(readModelPreference(f.ctx, "chat"), {});
});
test("catalog source failure and disk failure never claim preference saved", async (t) => {
  const f = fixture(t);
  f.catalog(Error("private source"));
  assert.equal((await f.run({ model: "m2" })).status, 503);
  f.catalog({
    defaultModel: "m1",
    items: [{ id: "m1", sort: 0, efforts: [] }],
  });
  const mock = t.mock.method(fs, "renameSync", () => {
    throw Error("private disk path");
  });
  const r = await f.run({ model: "m1" });
  mock.mock.restore();
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.data), /private/);
  assert.deepEqual(readModelPreference(f.ctx, "chat"), {});
});
test("symlinked state directories/records and corrupt new records fail closed", async (t) => {
  const f = fixture(t);
  writeModelPreference(f.ctx, "chat", { model: "m2" });
  const folder = path.join(f.accountDir(), "model-selections"),
    file = path.join(folder, hash("chat") + ".json");
  fs.writeFileSync(file, "not json");
  assert.throws(() => readModelPreference(f.ctx, "chat"));
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.root, "outside"), file);
  assert.throws(() => readModelPreference(f.ctx, "chat"));
  fs.unlinkSync(file);
  fs.rmdirSync(folder);
  fs.symlinkSync(f.root, folder);
  assert.throws(() => readModelPreference(f.ctx, "chat"));
});
test("concurrent surfaces do not overwrite each other or resurrect buffered aggregate values", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.accountDir(), { recursive: true });
  const aggregate = path.join(f.accountDir(), "model-selections.json");
  fs.writeFileSync(
    aggregate,
    JSON.stringify({ chat: { model: "m1" }, code: { model: "m1" } }),
  );
  const results = await Promise.all([
    f.run({ model: "m2" }, "chat"),
    f.run({ model: "m1", thinking: { type: "effort", effort: "low" } }, "code"),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  // Simulate an older adapter's delayed aggregate writer; new surface files take precedence.
  fs.writeFileSync(
    aggregate,
    JSON.stringify({ chat: { model: "m1" }, code: { model: "m2" } }),
  );
  assert.equal(readModelPreference(f.ctx, "chat").model, "m2");
  assert.equal(readModelPreference(f.ctx, "code").model, "m1");
  assert.equal(
    (readModelPreference(f.ctx, "code").thinking as any).effort,
    "low",
  );
});
