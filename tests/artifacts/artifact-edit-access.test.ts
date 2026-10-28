import test from "node:test";
import assert from "node:assert/strict";
import { ClaudexSharing } from "../../electron/sub2api/claudex-sharing";
import { parseSharedChat } from "../../shared/sharing";
import type { Fetch } from "../../electron/sub2api/http";

const token = "A".repeat(43);
test("access requests distinguish pending, already granted, unavailable, cooldown and transport failures", async () => {
  for (const [status, expected] of [
    ["pending", "filed"],
    ["already_pending", "filed"],
    ["already_granted", "already_granted"],
    ["unavailable", "unavailable"],
    ["unknown", "failed"],
  ]) {
    const fetchImpl: Fetch = async (url, init) => {
      assert.ok(
        String(url).endsWith(`/shared-with-me/${token}/artifact-access`),
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
      return Response.json({ code: 0, data: { status } });
    };
    assert.equal(
      await new ClaudexSharing(
        "https://claudex.test",
        fetchImpl,
      ).requestArtifactEditAccess("signed-in", token),
      expected,
    );
  }
  const limited = new ClaudexSharing("https://claudex.test", async () =>
    Response.json({ message: "cooldown" }, { status: 429 }),
  );
  assert.equal(
    await limited.requestArtifactEditAccess("signed-in", token),
    "cooldown",
  );
  const offline = new ClaudexSharing("https://claudex.test", async () => {
    throw new Error("offline");
  });
  assert.equal(
    await offline.requestArtifactEditAccess("signed-in", token),
    "failed",
  );
});

test("the owner can grant or decline requests through the authenticated service", async () => {
  for (const allow of [true, false]) {
    const service = new ClaudexSharing(
      "https://claudex.test",
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body, {
          email: "reader@example.com",
          decision: allow ? "granted" : "declined",
        });
        return Response.json({ code: 0, data: { status: body.decision } });
      },
    );
    await service.respondArtifactEditAccess(
      "signed-in",
      token,
      "reader@example.com",
      allow,
    );
  }
});

test("reader permissions and pending state survive the wire without exposing malformed requests", () => {
  const chat = parseSharedChat({
    kind: "artifact",
    token,
    title: "Report",
    owner: "owner@test",
    snapshot_at: "2026-10-14T00:00:00Z",
    can_edit: false,
    edit_request_pending: true,
    edit_requests: [
      {
        email: "reader@test",
        status: "pending",
        updated_at: "2026-10-14T00:00:00Z",
      },
      { email: "other@test", status: "granted" },
      null,
    ],
    snapshot: {
      artifacts: [
        { title: "Report", language: "html", content: "<p>Report</p>" },
      ],
    },
  })!;
  assert.equal(chat.canEdit, false);
  assert.equal(chat.editRequestPending, true);
  assert.deepEqual(chat.editRequests, [
    {
      email: "reader@test",
      status: "pending",
      updatedAt: Date.parse("2026-10-14T00:00:00Z"),
    },
  ]);
});
