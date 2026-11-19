import test from "node:test";
import assert from "node:assert/strict";
import { accountOf } from "../electron/official-ui/api/bootstrap";
import { organizationUuid } from "../electron/official-ui/api/context";
test("usage capability advertises installed readonly endpoint, not a paid plan or data availability", () => {
  let owner: any = { id: "one", email: "fixture@example.invalid" },
    current = true;
  const ctx: any = {
    account: () => owner,
    settings: () => ({}),
    isCurrent: () => current,
    modelCatalog: () => null,
  };
  assert.equal(accountOf(ctx)?.claudex_usage_summary, undefined);
  ctx.usageSummaryProtocol = "readonly-v1";
  assert.deepEqual(accountOf(ctx)?.claudex_usage_summary, {
    version: 1,
    account_uuid: "one",
    organization_uuid: organizationUuid("one"),
    read_only: true,
  });
  owner = { id: "two", email: "fixture@example.invalid" };
  assert.equal(accountOf(ctx)?.claudex_usage_summary?.account_uuid, "two");
  current = false;
  assert.equal(accountOf(ctx)?.claudex_usage_summary, undefined);
  owner = undefined;
  assert.equal(accountOf(ctx), undefined);
});
