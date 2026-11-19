import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalPolicyFor,
  codeSandboxFor,
  effectiveTurnSandbox,
  approvalsReviewerFor,
  taskSandboxFor,
} from "../../shared/sandbox-policy";

test("stored Chat, Cowork and Code retain the sandbox selected for the actual permission mode", () => {
  const sandboxes = [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const;
  for (const platform of ["win32", "darwin", "linux"] as const)
    for (const requested of sandboxes) {
      assert.equal(
        effectiveTurnSandbox(platform, "chat", requested),
        requested,
      );
      assert.equal(
        effectiveTurnSandbox(platform, "cowork", requested),
        requested,
      );
      assert.equal(
        effectiveTurnSandbox(platform, "code", requested),
        requested,
      );
    }
});

test("a task's permission mode picks its sandbox and who answers its requests", () => {
  // Manual is the default (live claude.ai bundle: draftPermissionMode "default").
  assert.equal(taskSandboxFor({}), "workspace-write");
  assert.equal(approvalsReviewerFor("cowork", {}), "user");
  assert.equal(approvalsReviewerFor("chat", {}), "user");
  assert.equal(
    approvalsReviewerFor("chat", { taskPermission: "auto" }),
    "auto_review",
  );
  assert.equal(
    approvalsReviewerFor("chat", { taskPermission: "auto" }, false, true),
    "user",
  );
  assert.equal(taskSandboxFor({ taskPermission: "auto" }), "workspace-write");
  assert.equal(
    approvalsReviewerFor("cowork", { taskPermission: "auto" }),
    "auto_review",
  );
  assert.equal(
    taskSandboxFor({ taskPermission: "bypass" }),
    "danger-full-access",
  );
  assert.equal(
    approvalsReviewerFor("cowork", { taskPermission: "bypass" }),
    "user",
  );
  // A scheduled run always has full access and nobody reviews.
  assert.equal(taskSandboxFor({}, true), "danger-full-access");
  assert.equal(
    approvalsReviewerFor("cowork", { taskPermission: "auto" }, true),
    "user",
  );
  // A task from an outside prompt asks the person, whatever the mode.
  assert.equal(
    taskSandboxFor({ taskPermission: "bypass" }, false, true),
    "workspace-write",
  );
  assert.equal(
    approvalsReviewerFor("cowork", { taskPermission: "auto" }, false, true),
    "user",
  );
  // Code uses its own session permission instead of the task preference.
  assert.equal(
    approvalsReviewerFor("code", { taskPermission: "auto" }),
    "user",
  );
  assert.equal(approvalsReviewerFor("code", {}, false, false, undefined, "auto"), "auto_review");
  for (const mode of ["manual", "acceptEdits", "plan", "bypass"] as const)
    assert.equal(approvalsReviewerFor("code", {}, false, false, undefined, mode), "user");
});

test("an explicit bypass session grants full access after account opt-in", () => {
  const settings = {
    codeSandbox: "danger-full-access" as const,
    codePlanMode: false,
    bypassFolders: ["/work/sandbox"],
    allowBypassPermissions: true,
  };
  assert.equal(codeSandboxFor(settings, "/work/sandbox"), "danger-full-access");
  assert.equal(codeSandboxFor(settings, "/work/other"), "workspace-write");
  assert.equal(codeSandboxFor(settings), "workspace-write");
  assert.equal(codeSandboxFor(settings, "/work/other", "bypass"), "danger-full-access");
  assert.equal(codeSandboxFor({ ...settings, allowBypassPermissions: false }, "/work/other", "bypass"), "workspace-write");
  assert.equal(
    codeSandboxFor({ ...settings, codePlanMode: true }, "/work/sandbox"),
    "read-only",
  );
  assert.equal(approvalPolicyFor("danger-full-access"), "never");
  assert.equal(approvalPolicyFor("workspace-write"), "on-request");
});
