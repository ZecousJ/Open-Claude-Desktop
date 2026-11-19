import assert from "node:assert/strict";
import test from "node:test";
import {
  coworkComputerUseCard,
  coworkComputerUseDecision,
} from "../electron/official-ui/native/cowork-computer-use";
import {
  defaultComputerUseSettings,
  type ComputerUseAccessRequest,
} from "../shared/computer-use";

const request: ComputerUseAccessRequest = {
  id: "49c75f8e-3f81-4ff9-b494-f19050e35878",
  conversationId: "fixture",
  kind: "apps",
  apps: [
    {
      app: { id: "com.apple.TextEdit", name: "TextEdit", platform: "darwin" },
      tier: "full",
    },
  ],
  clipboard: { read: true, write: false },
};
const state = {
  available: true,
  allowFullControl: true,
  settings: defaultComputerUseSettings,
};
const consent = {
  granted: [
    {
      bundleId: "com.apple.TextEdit",
      displayName: "TextEdit",
      grantedAt: 100,
      tier: "full",
    },
  ],
  denied: [],
  flags: { clipboardRead: true, clipboardWrite: false, systemKeyCombos: false },
  userConsented: true,
};

test("Cowork app consent grants only the displayed apps and clipboard operations", () => {
  const card = coworkComputerUseCard(request, state);
  assert.equal(card.sessionId, "local_fixture");
  assert.equal(card.toolName, "computer:request_access");
  assert.equal(card.input.apps[0].resolved.bundleId, "com.apple.TextEdit");
  assert.deepEqual(
    coworkComputerUseDecision(request, "always", {
      ...card.input,
      _cuGrants: consent,
    }),
    { allow: ["com.apple.TextEdit"], deny: [] },
  );
  assert.throws(
    () =>
      coworkComputerUseDecision(request, "always", {
        _cuGrants: {
          ...consent,
          flags: { ...consent.flags, clipboardWrite: true },
        },
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      coworkComputerUseDecision(request, "always", {
        _cuGrants: {
          ...consent,
          granted: [{ ...consent.granted[0], bundleId: "com.apple.Terminal" }],
        },
      }),
    /does not match/,
  );
  assert.throws(
    () => coworkComputerUseDecision(request, "once", card.input),
    /Confirm/,
  );
  assert.equal(coworkComputerUseDecision(request, "deny", card.input), "deny");
});

test("Cowork full-control consent and system-permission retry carry distinct decisions", () => {
  const control = {
    ...request,
    kind: "full-control",
    clipboard: undefined,
  } as const;
  assert.deepEqual(
    coworkComputerUseCard(control, state).input.takeoverFrom?.displayNames,
    ["TextEdit"],
  );
  const input = {
    _cuGrants: {
      ...consent,
      granted: [],
      flags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
    },
  };
  assert.deepEqual(coworkComputerUseDecision(control, "always", input), {
    allow: [],
    deny: [],
  });
  const permissions: ComputerUseAccessRequest = {
    ...control,
    kind: "permissions",
    apps: [],
  };
  assert.ok(coworkComputerUseCard(permissions, state).input.tccState);
  assert.equal(coworkComputerUseDecision(permissions, "deny", {}), "deny");
  assert.throws(
    () => coworkComputerUseDecision(permissions, "always", input),
    /Confirm/,
  );
});
