import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { codePreviewHost } from "../../server/official-code-preview";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  codePreviewFrameUrl,
  officialCodePreviewControl,
} from "../../shared/official-code-preview";
import {
  officialCodePreviewLease,
  runOfficialCodePreviewControl,
} from "../../runner/src/official-code-preview";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type { WebAppContext } from "../../runner/src/web-app-context";
import type { Conversation } from "../../shared/types";

test("expired Code preview leases refuse access and renew the same isolated origin", async () => {
  const account = { id: "alice" };
  const conversation: Conversation = {
    id: "code",
    mode: "code",
    title: "Preview",
    model: "model",
    providerId: "provider",
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    cwd: "/work",
    environment: { kind: "space", spaceId: "space" },
    turns: [],
  };
  let now = 1,
    activation = 1;
  const ctx = {
    userId: 42,
    activeAccount: account,
    store: { conversations: [conversation] },
    policy: () => ({}),
    officialSessionIdentity: () => activation,
  } as unknown as WebAppContext;
  const dispatcher = {
    context: (userId: number) => (userId === ctx.userId ? ctx : undefined),
    guard: { modes: ["code"] },
    now: () => now,
  } as unknown as Dispatcher;
  const user = {
    id: ctx.userId,
    accessToken: "token",
    webSession: { id: "signed-in", issuedAt: 1 },
  };
  const path = `/v1/code/sessions/session_${cloudCodeSessionKey(conversation, account.id)}/preview-token`;
  const control = officialCodePreviewControl("POST", path);
  assert.ok(control);
  const mint = async (port: number) => {
    const result = await runOfficialCodePreviewControl(
      dispatcher,
      { user } as CallFrame,
      ctx,
      control,
      {
        codeOrganizationId: organizationUuid(account.id),
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ port })),
      },
    );
    assert.equal(result.status, 200);
    return JSON.parse(Buffer.from(result.body).toString()).token;
  };
  const first = await mint(3000);
  const identify = (token: string) =>
    officialCodePreviewLease(dispatcher, {
      user,
      args: [token.split("-")[1]],
    } as CallFrame);
  assert.deepEqual(identify(first), user.webSession);
  now += 120_001;
  assert.equal(identify(first), undefined);
  assert.notEqual(await mint(3001), first);
  assert.equal(await mint(3000), first);
  assert.deepEqual(identify(first), user.webSession);
  activation++;
  assert.equal(identify(first), undefined);
  assert.notEqual(await mint(3000), first);
});

test("a Code preview URL retains its capability host and app path", () => {
  const label = "42-" + "a".repeat(32);
  const origin = "http://localhost:4000";
  assert.equal(
    codePreviewFrameUrl(origin, label, "/page?tab=1#section"),
    `http://${label}.localhost:4000/page?tab=1#section`,
  );
  for (const path of [
    "//other.test",
    "https://other.test",
    "/\\other.test",
    "/\n/other.test",
  ])
    assert.equal(codePreviewFrameUrl(origin, label, path), undefined);
});

test("public Code previews use distinct first-level hosts with matching relay tokens", () => {
  const origin = "https://usercontent-claudex.zecous.cn";
  const token = "1234567890123456-" + "a".repeat(32);
  const target = codePreviewFrameUrl(origin, token, "/page?tab=1#section");
  assert.equal(target, `https://p-${token}.zecous.cn/page?tab=1#section`);
  assert.ok(target);
  const request = new IncomingMessage(new Socket());
  request.headers.host = new URL(target).host;
  assert.equal(codePreviewHost(request, origin), token);
  assert.ok(request.headers.host.split(".")[0].length <= 63);
  const other = codePreviewFrameUrl(origin, "42-" + "b".repeat(32), "/");
  assert.ok(other);
  assert.notEqual(new URL(target).origin, new URL(other).origin);
  for (const host of [
    `p-${token}.unrelated.cn`,
    `p-${token}.zecous.cn.attacker.test`,
    `${token}.zecous.cn`,
    `p-${token}.zecous.cn:8443`,
    "usercontent-claudex.zecous.cn",
  ]) {
    request.headers.host = host;
    assert.equal(codePreviewHost(request, origin), undefined);
  }
  request.headers.host = `${token}.localhost:4000`;
  assert.equal(codePreviewHost(request, "http://localhost:4000"), token);
});
