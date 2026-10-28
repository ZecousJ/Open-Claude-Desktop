import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHostedShare,
  parseInviteResult,
  parseSharedChat,
  parseSharedChats,
} from "../../shared/sharing";

const base = "https://claudex.example.test";
const token = "A".repeat(43);
const wire = (extra: Record<string, unknown> = {}) => ({
  id: 5,
  kind: "conversation",
  source_key: "abc",
  title: "Plan",
  status: "active",
  path: `/s/${token}`,
  url: `${base}/s/${token}`,
  created_at: "2026-09-26T00:00:00Z",
  snapshot_at: "2026-09-26T01:00:00Z",
  ...extra,
});

test("a share limited to invited people says so, lists them and points into the web app", () => {
  const share = parseHostedShare(
    wire({
      invited_only: true,
      invites: ["ann@example.com", 7, "bo@example.com"],
    }),
    base,
  )!;
  assert.equal(share.access, "invited");
  assert.deepEqual(share.invites, ["ann@example.com", "bo@example.com"]);
  assert.equal(share.inviteUrl, `${base}/shared/${token}`);
});

test("a public share keeps its old shape, and artifact invitations reach the authenticated editor", () => {
  const link = parseHostedShare(wire({ invites: [] }), base)!;
  assert.equal(link.access, undefined);
  assert.equal(link.invites, undefined);
  assert.equal(link.inviteUrl, `${base}/shared/${token}`);
  const artifact = parseHostedShare(
    wire({ kind: "artifact", invited_only: true, invites: ["x@example.com"] }),
    base,
  )!;
  assert.equal(artifact.access, "invited");
  assert.deepEqual(artifact.invites, ["x@example.com"]);
  assert.equal(artifact.inviteUrl, `${base}/shared/${token}`);
});

test("hosted artifact previews and per-person roles accept only trusted values", () => {
  const share = parseHostedShare(
    wire({
      kind: "artifact",
      invites: ["x@example.com"],
      invite_roles: { "x@example.com": "comment", "y@example.com": "admin" },
      screenshot_url: `${base}/s/${token}/screenshot`,
    }),
    base,
  )!;
  assert.deepEqual(share.inviteRoles, { "x@example.com": "comment" });
  assert.equal(share.screenshotUrl, `${base}/s/${token}/screenshot`);
  assert.equal(
    parseHostedShare(
      wire({ screenshot_url: "https://elsewhere.test/pixel" }),
      base,
    )!.screenshotUrl,
    undefined,
  );
});

test("a service mounted under a prefix keeps it in the invitation link", () => {
  const prefixed = "https://host.example.test/claudex";
  const share = parseHostedShare(
    wire({ path: `/s/${token}`, url: `${prefixed}/s/${token}` }),
    prefixed,
  )!;
  assert.equal(share.inviteUrl, `${prefixed}/shared/${token}`);
});

test("an invitation's answer carries the share, whether it was new and whether mail went", () => {
  const result = parseInviteResult(
    {
      share: wire({ invited_only: true, invites: ["a@b.co"] }),
      added: true,
      mailed: false,
    },
    base,
  )!;
  assert.equal(result.added, true);
  assert.equal(result.mailed, false);
  assert.deepEqual(result.share.invites, ["a@b.co"]);
  assert.equal(parseInviteResult({ added: true }, base), undefined);
});

test("shared chats are listed and read field by field", () => {
  const list = parseSharedChats([
    {
      token,
      kind: "conversation",
      title: "Plan",
      owner: "ann@example.com",
      snapshot_at: "2026-09-26T01:00:00Z",
    },
    { token: "short", kind: "conversation" },
    { token, kind: "artifact", title: "x" },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].owner, "ann@example.com");
  assert.ok(list[0].snapshotAt > 0);

  const content = parseSharedChat({
    token,
    kind: "conversation",
    title: "Plan",
    owner: "ann@example.com",
    snapshot_at: "2026-09-26T01:00:00Z",
    snapshot: {
      messages: [
        { role: "user", text: "Make a plan" },
        {
          role: "assistant",
          text: "Here it is",
          activity: ["Ran a command", 3],
        },
        { role: "assistant", text: "" },
      ],
    },
  })!;
  assert.deepEqual(
    content.messages.map((m) => [m.role, m.text]),
    [
      ["user", "Make a plan"],
      ["assistant", "Here it is"],
    ],
  );
  assert.deepEqual(content.messages[1].activity, ["Ran a command"]);
  assert.equal(parseSharedChat({ token, kind: "conversation" }), undefined);
});

test("an invited artifact keeps its editable source and private comments", () => {
  const content = parseSharedChat({
    token,
    kind: "artifact",
    snapshot: {
      artifacts: [{ title: "Chart", language: "svg", content: "<svg/>" }],
      comments: [{ author: "ann@example.com", text: "Please review" }],
    },
  })!;
  assert.equal(content.kind, "artifact");
  assert.deepEqual(content.artifacts, [
    { title: "Chart", language: "svg", content: "<svg/>" },
  ]);
  assert.deepEqual(content.messages, [
    { role: "user", text: "ann@example.com: Please review" },
  ]);
});
