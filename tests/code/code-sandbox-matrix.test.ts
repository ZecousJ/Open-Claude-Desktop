import test from "node:test";
import assert from "node:assert/strict";
import { codeTurnPermissions } from "../../shared/sandbox-policy";

test("Local sandbox and Strict sandbox mode never give silent full access", () => {
  const off = { localSandboxOff: true };
  const strict = { strictSandbox: true };
  // Default and Accept edits work in the folder's sandbox.
  assert.deepEqual(codeTurnPermissions("workspace-write", {}), {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  // Sandbox off: no sandbox, but every untrusted command asks.
  assert.deepEqual(codeTurnPermissions("workspace-write", off), {
    sandbox: "danger-full-access",
    approvalPolicy: "untrusted",
  });
  // Strict: nothing escalates out of the sandbox; the rest still asks.
  const strictTurn = codeTurnPermissions("workspace-write", strict);
  assert.equal(strictTurn.sandbox, "workspace-write");
  assert.deepEqual(strictTurn.approvalPolicy, {
    granular: {
      sandbox_approval: false,
      rules: true,
      mcp_elicitations: true,
      request_permissions: true,
      skill_approval: true,
    },
  });
  // Plan mode stays read-only and Bypass stays Bypass, whatever the switches.
  for (const session of [{}, off, strict]) {
    assert.deepEqual(codeTurnPermissions("read-only", session), {
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    assert.deepEqual(codeTurnPermissions("danger-full-access", session), {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  }
});
