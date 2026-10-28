import test from "node:test";
import assert from "node:assert/strict";
import {
  homeRelative,
  mcpSummary,
  sessionInfoGroups,
  sessionInfoReport,
  shortId,
} from "../../src/session-info/session-info-model";
import type { Conversation } from "../../shared/types";

const conversation = {
  id: "c-123",
  threadId: "019a7c1e-2b3c-7d4e-8f90-123456789abc",
  title: "t",
  mode: "code",
  cwd: "/Users/me/Developer/app",
  createdAt: Date.UTC(2026, 9, 15, 3, 0),
  turns: [],
} as unknown as Conversation;

test("Session info lists the session, its environment and the account in the original's order", () => {
  const groups = sessionInfoGroups({
    conversation,
    environment: {
      version: "0.0.27",
      platform: "darwin",
      osVersion: "15.4",
      arch: "arm64",
      home: "/Users/me",
    },
    model: "Opus 5.5",
    effort: "High",
    permissions: "Auto",
    sandboxOn: true,
    mcp: [
      { name: "a", state: "ready", tools: 1 },
      { name: "b", state: "failed", tools: 0 },
    ],
    account: "me@example.com",
    when: () => "Oct 15",
  });
  assert.deepEqual(
    groups.map((g) => g.id),
    ["session", "environment", "account"],
  );
  assert.deepEqual(
    groups[0].rows.map((r) => r.id),
    [
      "desktopApp",
      "model",
      "permissions",
      "started",
      "sessionId",
      "desktopSessionId",
    ],
  );
  assert.equal(groups[0].rows[0].value, "0.0.27 · macOS 15.4 (arm64)");
  assert.equal(groups[0].rows[1].value, "Opus 5.5 · High");
  assert.equal(groups[0].rows[4].value, "019a7c1e…");
  assert.equal(groups[0].rows[4].copyable, true);
  assert.equal(groups[0].rows[5].reportOnly, true);
  assert.equal(
    groups[1].rows.find((r) => r.id === "folder")!.value,
    "~/Developer/app",
  );
  assert.equal(
    groups[1].rows.find((r) => r.id === "mcp")!.value,
    "1 connected · 1 failed",
  );
  const report = sessionInfoReport(groups, "2026-10-15T03:00:00.000Z");
  assert.match(
    report,
    /^Claudex Code session info \(2026-10-15T03:00:00.000Z\)\n\nSession:\n- Desktop app:/,
  );
  assert.match(report, /- Session ID: 019a7c1e-2b3c-7d4e-8f90-123456789abc/);
  assert.match(report, /- Desktop session ID: c-123/);
});

test("ids, home paths and MCP counts read as the original's", () => {
  assert.equal(shortId("short-id"), "short-id");
  assert.equal(homeRelative("/Users/me", "/Users/me"), "~");
  assert.equal(homeRelative("/Users/meow/x", "/Users/me"), "/Users/meow/x");
  assert.equal(mcpSummary([]), "None");
  assert.equal(
    mcpSummary([
      { name: "x", state: "ready", authStatus: "notLoggedIn", tools: 0 },
    ]),
    "1 needs sign-in",
  );
});
