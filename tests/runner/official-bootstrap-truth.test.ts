import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountOf,
  bootstrapOf,
  organizationOf,
  modelSelectorOf,
} from "../../electron/official-ui/api/bootstrap";
import { fixtureRoute } from "../../electron/official-ui/api/fixtures";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";
function fixture(t: any, recorded = true) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-bootstrap-truth-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (recorded) {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(
      path.join(root, "data/bootstrap-defaults.json"),
      JSON.stringify({
        org_growthbook: { features: { "1282688181": { defaultValue: true } } },
        organization_template: {
          capabilities: ["chat", "raven", "claude_pro", "claude_max"],
          rate_limit_tier: "default_claude_max_20x",
          billing_type: "google_play_subscription",
          merchant_of_record: "anthropic",
          settings: { claude_ai_chat_sharing_enabled: true },
        },
        account_settings_template: {
          enabled_web_search: true,
          enabled_wiggle_egress: true,
          default_model: "recorded-private-model",
          personalized_drafts: true,
        },
      }),
    );
  }
  let settings: any = {};
  const ctx: any = {
    root,
    account: () => ({
      id: "real-account",
      email: "fixture@example.invalid",
      name: "Fixture",
      plan: "Operator Custom",
    }),
    settings: () => settings,
    modelCatalog: async () => null,
    call: async () => null,
    log() {},
    readOnly: true,
  };
  return {
    ctx,
    set: (value: any) => {
      settings = value;
    },
  };
}
test("the recovered network secrets gate is off on the browser host", async (t) => {
  const { ctx } = fixture(t);
  const web = await bootstrapOf(ctx);
  const desktop = await bootstrapOf({ ...ctx, readOnly: false });
  assert.equal(web.org_growthbook.features["1282688181"].defaultValue, false);
  assert.equal(desktop.org_growthbook.features["1282688181"].defaultValue, true);
});

test("recorded and missing bootstrap never confer vendor paid tiers, merchant or subscription", (t) => {
  for (const recorded of [true, false]) {
    const f = fixture(t, recorded);
    const org = organizationOf(f.ctx)!;
    assert.deepEqual(org.capabilities, ["chat"]);
    assert.equal(org.billing_type, null);
    assert.equal(org.rate_limit_tier, null);
    assert.equal(org.merchant_of_record, null);
    assert.equal(org.plan_display_name, "Operator Custom");
    assert.deepEqual(org.settings, {});
    const account = accountOf(f.ctx)!;
    assert.equal(account.has_claude_pro, false);
  }
});
test("captured private preferences are not reused; explicit real settings remain unchanged", (t) => {
  const f = fixture(t);
  const unknown = accountOf(f.ctx)!;
  for (const key of [
    "enabled_web_search",
    "default_model",
    "personalized_drafts",
  ])
    assert.equal(Object.hasOwn(unknown.settings, key), false);
  assert.equal(unknown.settings.preview_feature_uses_artifacts, true);
  assert.equal(unknown.settings.enabled_wiggle_egress, true);
  for (const enabled of [true, false]) {
    f.set({ artifacts: enabled, networkEgress: enabled, theme: "dark", name: "Preferred" });
    const a = accountOf(f.ctx)!;
    assert.equal(a.settings.preview_feature_uses_artifacts, enabled);
    assert.equal(a.settings.enabled_wiggle_egress, enabled);
    assert.equal(a.settings.theme, "dark");
    assert.equal(a.display_name, "Preferred");
  }
});
test("missing/failed model service cannot resurrect recorded paid models", async (t) => {
  const f = fixture(t);
  const base = {
    model_selector_config: [
      { id: "chat", models: [{ id: "recorded-private-model" }] },
    ],
    model_selector_state: [{ model: "recorded-private-model" }],
    claude_ai_available_models: {
      models: [{ model_id: "recorded-private-model" }],
    },
  };
  for (const modelCatalog of [
    async () => null,
    async () => {
      throw Error("offline");
    },
    async () => ({ items: [] }),
  ]) {
    const value = await modelSelectorOf({ ...f.ctx, modelCatalog }, base);
    assert.deepEqual(value.available, { models: [] });
    assert.deepEqual(value.state, []);
    assert.deepEqual(value.config, [{ id: "chat", models: [] }]);
  }
});
test("real catalog selection stays available without paid tier spoof", async (t) => {
  const f = fixture(t);
  f.set({ providers: [], effort: "medium", codeEffort: "high" });
  await inAdapterScope(newAdapterScope("catalog-test"), async () => {
    const value = await modelSelectorOf(
      {
        ...f.ctx,
        modelCatalog: async () => ({
          defaultModel: "operator-model",
          items: [
            {
              id: "operator-model",
              displayName: "Operator Model",
              sort: 0,
              hidden: false,
              efforts: [],
              webSearch: "none",
            },
          ],
        }),
      },
      {},
    );
    assert.equal(value.config[0].models[0].id, "operator-model");
    assert.equal(value.state[0].model, "operator-model");
  });
});
test("model context limits retain published values and omit unknown limits", async (t) => {
  const f = fixture(t);
  const value = await modelSelectorOf({
    ...f.ctx,
    modelCatalog: async () => ({
      defaultModel: "known",
      items: [
        { id: "known", displayName: "Known", sort: 0, contextWindow: 200_000 },
        { id: "unknown", displayName: "Unknown", sort: 1 },
      ],
    }),
  }, {});
  for (const surface of value.config) {
    assert.equal(surface.models[0].hard_limit, 200_000);
    assert.equal(Object.hasOwn(surface.models[1], "hard_limit"), false);
  }
});
test("vendor subscription/pricing/balance fallbacks return unavailable, never invented financial facts", async () => {
  for (const [p, method] of [
    ["/api/organizations/o/subscription_status", "GET"],
    ["/api/organizations/o/subscription_details", "GET"],
    ["/api/stripe/o/balance", "GET"],
    ["/api/billing/o/consumer_pricing", "POST"],
  ]) {
    let status = 0,
      data: any;
    const req: any = { method };
    const res: any = {
      writeHead(s: number) {
        status = s;
      },
      end(x: string) {
        data = JSON.parse(x);
      },
    };
    assert.equal(await fixtureRoute(req, res, p), true);
    assert.equal(status, 404);
    assert.equal(data.error.type, "not_found_error");
    assert.equal(data.active, undefined);
    assert.equal(data.price, undefined);
    assert.equal(data.balance, undefined);
  }
});

test("readonly bootstrap cannot persist model preferences or dispatch mutations", async (t) => {
  const { bootstrapRoute } =
    await import("../../electron/official-ui/api/bootstrap");
  const { organizationUuid } =
    await import("../../electron/official-ui/api/context");
  const f = fixture(t);
  let status = 0;
  const req: any = {
    method: "PUT",
    on() {
      throw Error("Readonly must not consume mutation body");
    },
  };
  const res: any = {
    writeHead(s: number) {
      status = s;
    },
    end() {},
  };
  await bootstrapRoute(
    req,
    res,
    "/api/organizations/" +
      organizationUuid("real-account") +
      "/model_selector_state/chat",
    f.ctx,
  );
  assert.equal(status, 501);
  assert.deepEqual(fs.readdirSync(f.ctx.root), ["data"]);
});
