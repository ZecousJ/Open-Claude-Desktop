import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPolicy } from "../../shared/client-policy";
import { sessionWideGrant } from "../../shared/approval-grants";
import {
  allowsAlways,
  approvalResponse,
} from "../../src/approval/approval-model";
import { displayPath } from "../../src/approval/ApprovalBody";
import { ApprovalCard } from "../../src/ui/ApprovalCard";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Approval } from "../../shared/types";
import type { Conversation } from "../../shared/types";

const command: Approval = {
  id: 7,
  conversationId: "c",
  method: "item/commandExecution/requestApproval",
  params: { command: "npm test" },
};
const permissions: Approval = {
  id: 8,
  conversationId: "c",
  method: "item/permissions/requestApproval",
  params: { permissions: { network: { enabled: true } } },
};

test("adding a Cowork folder grants this session without trusting future scheduled runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-folder-grant-"));
  const store = new Store(root);
  try {
    store.conversations.push({
      id: "c",
      mode: "cowork",
      scheduledTaskId: "routine",
      turns: [],
    } as unknown as Conversation);
    const request: Approval = {
      ...permissions,
      params: {
        permissions: {
          fileSystem: { read: ["/reports"], write: ["/reports"] },
        },
      },
    };
    const responses: unknown[] = [];
    const kept: unknown[] = [];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    engine.policy = () => openPolicy;
    engine.rpc = {
      respond: (_id: unknown, result: unknown) => responses.push(result),
    } as any;
    engine.routineApprovals = {
      allowed: () => [],
      allow: (...entry) => {
        kept.push(entry);
      },
    };
    (engine as any).approvals = [request];
    const response = approvalResponse(request, "always");
    engine.approve(request.id, response);
    assert.deepEqual(responses, [response]);
    assert.deepEqual(kept, []);
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session-wide grants are exactly the Always allow responses", () => {
  assert.equal(sessionWideGrant(approvalResponse(command, "always")), true);
  assert.equal(sessionWideGrant(approvalResponse(permissions, "always")), true);
  for (const choice of ["once", "deny"] as const) {
    assert.equal(sessionWideGrant(approvalResponse(command, choice)), false);
    assert.equal(
      sessionWideGrant(approvalResponse(permissions, choice)),
      false,
    );
  }
  assert.equal(
    sessionWideGrant({
      decision: { acceptWithExecpolicyAmendment: { command: ["ls"] } },
    }),
    true,
  );
  assert.equal(
    sessionWideGrant({
      decision: {
        applyNetworkPolicyAmendment: { host: "example.com", action: "allow" },
      },
    }),
    true,
  );
});

test("the card hides Always allow when the administrator turns it off", () => {
  assert.equal(allowsAlways(command, openPolicy), true);
  assert.equal(
    allowsAlways(command, { ...openPolicy, approvalsAlwaysAllow: false }),
    false,
  );
  // Without a policy provider the open policy applies.
  const html = renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval: command,
      frontmost: false,
      mac: true,
      onError: () => {},
    }),
  );
  // Always allow sits in Allow once's More allow options (as the original).
  assert.match(html, /More allow options/);
});

test("the engine refuses a session-wide grant when Always allow is off", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-always-"));
  const store = new Store(root);
  try {
    const responses: unknown[] = [];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    engine.rpc = {
      respond: (_id: unknown, result: unknown) => responses.push(result),
    } as any;
    (engine as any).approvals = [command, permissions];
    engine.policy = () => ({ ...openPolicy, approvalsAlwaysAllow: false });
    assert.throws(
      () => engine.approve(7, approvalResponse(command, "always")),
      /approving each request/,
    );
    assert.throws(
      () => engine.approve(8, approvalResponse(permissions, "always")),
      /approving each request/,
    );
    assert.equal(responses.length, 0);
    // The request stays open, and Allow once still answers it.
    engine.approve(7, approvalResponse(command, "once"));
    assert.deepEqual(responses, [{ decision: "accept" }]);
    engine.policy = () => openPolicy;
    engine.approve(8, approvalResponse(permissions, "always"));
    assert.equal(responses.length, 2);
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file approvals name the file relative to the folder, absolute outside it", () => {
  assert.equal(
    displayPath("/work/repo/src/app.js", "/work/repo"),
    "src/app.js",
  );
  assert.equal(displayPath("/work/repo/app.js", "/work/repo/"), "app.js");
  assert.equal(
    displayPath("/tmp/claudex-ref-permission-probe.txt", "/work/repo"),
    "/tmp/claudex-ref-permission-probe.txt",
  );
  assert.equal(
    displayPath("/work/repository/a.js", "/work/repo"),
    "/work/repository/a.js",
  );
  assert.equal(
    displayPath("C:\\work\\repo\\app.js", "C:\\work\\repo"),
    "app.js",
  );
});
