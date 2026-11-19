import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountOf } from "../../electron/official-ui/api/bootstrap";

test("an account email is not proof of verified email; reads do not mutate real settings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-access-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = Object.freeze({ theme: "dark", artifacts: false });
  const account = Object.freeze({
    id: "fixture",
    email: "fixture@example.invalid",
    name: "Fixture",
    remote: true,
  });
  const ctx: any = {
    root,
    account: () => account,
    settings: () => settings,
    readOnly: true,
    call() {
      throw Error("No consent or verification call is permitted");
    },
  };
  const result = accountOf(ctx)!;
  for (const field of ["email_verified", "is_verified", "age_is_verified"])
    assert.equal(Object.hasOwn(result, field), false);
  assert.deepEqual(result.claudex_host_authentication, {
    version: 1,
    status: "authenticated",
    account_uuid: account.id,
  });
  assert.equal(accountOf({ ...ctx, account: () => undefined }), undefined);
  assert.equal(result.email_address, account.email);
  assert.equal(result.settings.preview_feature_uses_artifacts, false);
  assert.deepEqual(settings, { theme: "dark", artifacts: false });
  assert.equal(fs.readdirSync(root).length, 0);
});
