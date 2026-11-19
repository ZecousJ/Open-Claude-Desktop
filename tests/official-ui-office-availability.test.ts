import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  bootstrapOf,
  bootstrapRoute,
  currentUserAccessOf,
  canSearch,
} from "../electron/official-ui/api/bootstrap";
import { createGeneratedOutputFixture } from "./support/generated-output-fixture";

test("initial bootstrap and access refresh report the desktop host's supported features", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-office-policy-"));
  const f = await createGeneratedOutputFixture(root);
  t.after(() => {
    f.store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const defaults = {
    features: [
      { feature: "work_across_apps", status: "available" },
      { feature: "chat", status: "available" },
      { feature: "dramatic_shrimp", status: "available" },
      { feature: "web_search", status: "available" },
      { feature: "example_admin_feature", status: "blocked_by_org_admin" },
    ],
    account_features: [],
    organization_permissions: ["fixture_permission"],
  };
  const build = path.join(root, "build");
  fs.mkdirSync(path.join(build, "data"), { recursive: true });
  const recorded = path.join(build, "data/bootstrap-defaults.json");
  fs.writeFileSync(recorded, JSON.stringify({ current_user_access: defaults }));
  f.ctx.root = build;
  f.ctx.localCall = f.ctx.call;
  let webSearchAllowed = false;
  f.ctx.webSearchAllowed = () => webSearchAllowed;
  const initial = (await bootstrapOf(f.ctx)).current_user_access;
  let refreshed: any;
  await bootstrapRoute(
    { method: "GET" } as any,
    {
      writeHead(status: number) {
        assert.equal(status, 200);
      },
      end(body: string) {
        refreshed = JSON.parse(body);
      },
    } as any,
    "/api/bootstrap/fixture/current_user_access",
    f.ctx,
  );
  assert.deepEqual(initial, refreshed);
  assert.equal(
    initial.features.find((row: any) => row.feature === "work_across_apps")
      .status,
    "blocked_by_platform",
  );
  assert.deepEqual(
    initial.features,
    defaults.features.map((row) =>
      ["work_across_apps", "dramatic_shrimp"].includes(row.feature)
        ? { ...row, status: "blocked_by_platform" }
        : row.feature === "web_search"
          ? { ...row, status: "blocked_by_org_admin" }
        : row,
    ),
  );
  assert.deepEqual(
    currentUserAccessOf({ ...f.ctx, readOnly: true }).features.find(
      (row: { feature: string }) => row.feature === "dramatic_shrimp",
    ),
    { feature: "dramatic_shrimp", status: "available" },
  );
  assert.deepEqual(
    initial.organization_permissions,
    defaults.organization_permissions,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(recorded, "utf8")).current_user_access,
    defaults,
  );
  const web = { ...f.ctx, readOnly: true };
  assert.equal(currentUserAccessOf(web).features.find((row: { feature: string }) => row.feature === "web_search")?.status, "blocked_by_org_admin");
  assert.equal(canSearch(web, "fixture-model"), false);
  webSearchAllowed = true;
  assert.equal(currentUserAccessOf(web).features.find((row: { feature: string }) => row.feature === "web_search")?.status, "available");
});

const consumer = path.resolve(
  "build/official-ui/ui/assets/v1/shared-6-abVJ5RR0.js",
);
test(
  "the original shared Office eligibility gate hides promotion instead of offering an upgrade",
  { skip: !fs.existsSync(consumer) },
  () => {
    const source = fs.readFileSync(consumer, "utf8");
    const blocked = source.match(/function An\(e\) \{[\s\S]*?\n\}/)?.[0];
    const gate = source.match(/function Qx\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(blocked);
    assert.ok(gate);
    const access = currentUserAccessOf({
      root: path.resolve("build/official-ui"),
    } as any);
    const evaluate = (status: string) =>
      vm.runInNewContext(`${blocked}\n${gate}\nQx()`, {
        J9: () => [],
        J1: () => true,
        I1: (_cache: any, _index: number, value: any) => value,
        Cb: (feature: string) => {
          assert.equal(feature, "work_across_apps");
          return { status };
        },
      });
    assert.equal(evaluate("available"), true);
    assert.equal(
      evaluate(
        access.features.find((row: any) => row.feature === "work_across_apps")
          .status,
      ),
      false,
    );
  },
);
