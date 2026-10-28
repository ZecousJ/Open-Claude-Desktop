import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { DesktopAPI } from "../../shared/types";
import {
  actionVerificationError,
  actionVerificationMarker,
} from "../../shared/action-verification";
import {
  actionVerificationStore,
  ActionVerificationHandled,
  withActionVerification,
} from "../../src/auth/action-verification-store";
import { apiError } from "../../shared/web-client/errors";
import { createAccountProfileMethods } from "../../src-web/bridge/account-profile";
import {
  verificationDescription,
  verificationResend,
} from "../../src/auth/ActionVerificationDialog";

test("web and Electron IPC preserve the action label and cooldown", () => {
  const metadata = {
    action_label: "delete your account",
    retry_after_seconds: 60,
  };
  const web = apiError(403, {
    reason: "action_verification_required",
    message: "Confirm it’s you",
    metadata,
  });
  const desktop = Error(
    actionVerificationMarker +
      JSON.stringify({ code: "action_verification_required", metadata }),
  );
  assert.deepEqual(actionVerificationError(web), {
    code: "action_verification_required",
    actionLabel: "delete your account",
    seconds: 60,
  });
  assert.deepEqual(
    actionVerificationError(desktop),
    actionVerificationError(web),
  );
  assert.equal(
    actionVerificationError(Error(actionVerificationMarker + "bad json")),
    undefined,
  );
});

test("refusals open one dialog without replaying or resolving the sensitive action", async () => {
  actionVerificationStore.close();
  let calls = 0;
  let verified = false;
  const api = withActionVerification({
    deleteAccount: async () => {
      calls++;
      if (!verified)
        throw apiError(403, {
          reason: "action_verification_required",
          metadata: { action_label: "delete your account" },
        });
      return { hasAccounts: false };
    },
  } as DesktopAPI);
  await assert.rejects(api.deleteAccount(), ActionVerificationHandled);
  const active = actionVerificationStore.snapshot();
  assert.equal(active?.actionLabel, "delete your account");
  await assert.rejects(api.deleteAccount(), ActionVerificationHandled);
  assert.equal(actionVerificationStore.snapshot(), active);
  verified = true;
  assert.equal(calls, 2, "verification does not repeat the original action");
  actionVerificationStore.close();
  assert.deepEqual(await api.deleteAccount(), { hasAccounts: false });
  assert.equal(calls, 3);
});

test("the web sends and confirms directly against Go, never a runner", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const methods = createAccountProfileMethods(
    {
      json: async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return { code: 0, data: { retry_after_seconds: 60 } };
      },
    },
    "https://example.com",
  );
  assert.deepEqual(await methods.sendActionVerification(), {
    retry_after_seconds: 60,
  });
  await methods.confirmActionVerification("012345");
  assert.equal(calls[0].path, "/api/v1/claudex/action-verification/send");
  assert.equal(calls[1].path, "/api/v1/claudex/action-verification/confirm");
  assert.equal(calls[1].init?.body, '{"code":"012345"}');
});

test("the official dialog copy stays plain-placeholder compatible and lazily mounted", () => {
  assert.match(verificationDescription, /before you \{actionLabel\}/);
  assert.match(verificationDescription, /\{codeLength\}-digit/);
  assert.equal(
    verificationResend,
    "Didn’t get it? Check your spam folder, or {resend}.",
  );
  const source = readFileSync(
    new URL("../../src/app/AppOverlays.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /lazyPiece\(\s*\(\) => import\("\.\.\/auth\/ActionVerificationDialog"\)/,
  );
  assert.match(source, /return\s+active\s*\?\s*\(?\s*<Suspense/);
  const routes = readFileSync(
    new URL(
      "../../backend/backend/internal/server/routes/user.go",
      import.meta.url,
    ),
    "utf8",
  );
  for (const label of [
    "change your password",
    "change your email",
    "create an API key",
  ])
    assert.ok(routes.includes(`ActionVerificationGuard("${label}")`));
});
