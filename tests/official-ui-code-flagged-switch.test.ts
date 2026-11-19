import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Store } from "../electron/store/store";
import { settingsSchema } from "../electron/store/settings-schema";
import { accountOf } from "../electron/official-ui/api/bootstrap";
import { connectorsRoute } from "../electron/official-ui/api/connectors";
import { saveOfficialCodeFlaggedSwitch } from "../electron/official-ui/api/classification-settings";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classification-setting-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let owner = "synthetic",
    activation: unknown = {},
    current = true;
  const calls: any[] = [];
  const ctx: any = {
    root: "build/official-ui",
    account: () => ({ id: owner }),
    settings: () => store.settings,
    sessionIdentity: () => activation,
    isCurrent: () => current,
    call: async () => {
      throw Error("Unexpected service/model call");
    },
    log: () => {},
    localCall: async (method: string, settings: any) => {
      assert.equal(method, "saveSettings");
      calls.push(settings);
      store.settings = settingsSchema.parse(settings) as any;
      store.flush();
    },
  };
  const scope = newAdapterScope(owner, dir, activation);
  const route = async (body: any) => {
    const req: any = Object.assign(
      Readable.from([Buffer.from(JSON.stringify(body))]),
      { method: "PATCH" },
    );
    let status = 0,
      text = "";
    const res: any = {
      writeHead: (s: number) => (status = s),
      end: (s = "") => (text += s),
    };
    await inAdapterScope(scope, () =>
      connectorsRoute(req, res, "/api/account/settings", ctx),
    );
    return { status, body: JSON.parse(text) };
  };
  return {
    ctx,
    store,
    calls,
    route,
    dir,
    retire: () => {
      current = false;
    },
    aba: () => {
      activation = {};
    },
    foreign: () => {
      owner = "other";
    },
  };
}
test("bootstrap reads actual default/explicit preference without writes or classification", (t) => {
  const f = fixture(t);
  for (const value of [undefined, false, true]) {
    f.store.settings = { ...f.store.settings, switchModelsOnFlag: value };
    const a = accountOf(f.ctx)!;
    assert.equal(a.settings.ccr_switch_models_on_flag, value ?? true);
  }
  assert.equal(f.calls.length, 0);
});
test("exact native PATCH true/false reaches existing save operation and persists on reopen", async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.store.settings);
  for (const enabled of [false, true]) {
    const result = await f.route({ ccr_switch_models_on_flag: enabled });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ccr_switch_models_on_flag: enabled });
    assert.equal(new Store(f.dir).settings.switchModelsOnFlag, enabled);
    assert.deepEqual(f.calls.at(-1), {
      ...before,
      switchModelsOnFlag: enabled,
    });
  }
  assert.equal(f.calls.length, 2);
});
test("bad/mixed payloads, readonly and missing native authority never write", async (t) => {
  const f = fixture(t);
  for (const body of [
    { ccr_switch_models_on_flag: "false" },
    { ccr_switch_models_on_flag: 0 },
    { ccr_switch_models_on_flag: null },
    { ccr_switch_models_on_flag: true, enabled_mcp_tools: {} },
    { ccr_switch_models_on_flag: true, chat_font: "serif" },
    { unknown: true },
  ])
    assert.notEqual((await f.route(body)).status, 200);
  f.ctx.readOnly = true;
  assert.equal(
    (await f.route({ ccr_switch_models_on_flag: true })).status,
    403,
  );
  f.ctx.readOnly = false;
  delete f.ctx.localCall;
  assert.equal(
    (
      await saveOfficialCodeFlaggedSwitch(f.ctx, {
        ccr_switch_models_on_flag: true,
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});
test("expired or missing lease refuses; retirement/ABA after dispatch never reports confirmed success", async (t) => {
  for (const invalidate of ["retire", "aba", "foreign"] as const) {
    const f = fixture(t);
    let release!: () => void;
    f.ctx.localCall = async () => {
      await new Promise<void>((r) => (release = r));
    };
    const pending = saveOfficialCodeFlaggedSwitch(f.ctx, {
      ccr_switch_models_on_flag: false,
    });
    f[invalidate]();
    release();
    assert.equal((await pending).status, 409);
  }
  const f = fixture(t);
  f.retire();
  assert.equal(
    (
      await saveOfficialCodeFlaggedSwitch(f.ctx, {
        ccr_switch_models_on_flag: true,
      })
    ).status,
    409,
  );
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  delete g.ctx.sessionIdentity;
  assert.equal(
    (
      await saveOfficialCodeFlaggedSwitch(g.ctx, {
        ccr_switch_models_on_flag: true,
      })
    ).status,
    409,
  );
});
test("existing policy/integration/persistence errors remain failures, no retries or raw error exposure", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.ctx.localCall = async () => {
    calls++;
    throw Error("SECRET raw service data");
  };
  const r = await saveOfficialCodeFlaggedSwitch(f.ctx, {
    ccr_switch_models_on_flag: false,
  });
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  assert.equal(calls, 1);
});

test("same-value and effective-default acknowledgements do not save, but still require native authority and lease", async (t) => {
  const f = fixture(t);
  for (const value of [undefined, true, false]) {
    f.store.settings = { ...f.store.settings, switchModelsOnFlag: value };
    const expected = value ?? true;
    for (let n = 0; n < 2; n++)
      assert.equal(
        (
          await saveOfficialCodeFlaggedSwitch(f.ctx, {
            ccr_switch_models_on_flag: expected,
          })
        ).status,
        200,
      );
    assert.equal(f.store.settings.switchModelsOnFlag, value);
  }
  assert.equal(f.calls.length, 0);
  f.ctx.readOnly = true;
  assert.equal(
    (
      await saveOfficialCodeFlaggedSwitch(f.ctx, {
        ccr_switch_models_on_flag: false,
      })
    ).status,
    403,
  );
  f.ctx.readOnly = false;
  f.retire();
  assert.equal(
    (
      await saveOfficialCodeFlaggedSwitch(f.ctx, {
        ccr_switch_models_on_flag: false,
      })
    ).status,
    409,
  );
  const g = fixture(t);
  delete g.ctx.sessionIdentity;
  assert.equal(
    (
      await saveOfficialCodeFlaggedSwitch(g.ctx, {
        ccr_switch_models_on_flag: true,
      })
    ).status,
    409,
  );
  assert.equal(g.calls.length, 0);
});

test("original model fallback writes only the active account and checks a Code companion", async (t) => {
  const f = fixture(t);
  assert.equal(accountOf(f.ctx)?.settings.enabled_model_auto_fallback, true);
  const change = { enabled_model_auto_fallback: false };
  assert.deepEqual(await f.route(change), { status: 200, body: change });
  assert.equal(new Store(f.dir).settings.modelAutoFallback, false);
  assert.equal(accountOf(f.ctx)?.settings.enabled_model_auto_fallback, false);
  assert.equal((await f.route({ ccr_switch_models_on_flag: false, enabled_model_auto_fallback: true })).status, 409);
  assert.equal((await f.route({ ccr_switch_models_on_flag: false, ...change })).status, 200);
  assert.equal(f.store.settings.switchModelsOnFlag, false);
  const reset = { enabled_model_auto_fallback: true, ccr_switch_models_on_flag: null };
  assert.deepEqual(await f.route(reset), { status: 200, body: reset });
  assert.equal(new Store(f.dir).settings.switchModelsOnFlag, undefined);
  assert.equal(f.store.settings.modelAutoFallback, true);
  assert.equal((await f.route({ ...change, chat_font: "sans" })).status, 400);
  assert.equal((await f.route({ enabled_model_auto_fallback: "false" })).status, 400);
  f.retire();
  assert.equal((await f.route(change)).status, 409);
  assert.equal(f.calls.length, 3);
});
