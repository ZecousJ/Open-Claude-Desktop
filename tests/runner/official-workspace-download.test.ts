import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { Store } from "../../electron/store/store";
import { officialUiRead } from "../../runner/src/official-ui-read";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { Conversation, Mode } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";

test("original workspace download routes return current Code and Cowork file bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "profile"));
  const owner = "fixture-owner";
  const organization = organizationUuid(owner);
  const spaceRoot = (id: string) => path.join(store.root, "spaces", id);
  const coworkWorkspace = path.join(spaceRoot("c-fixture"), "workspace");
  const codeWorkspace = path.join(
    spaceRoot("s-fixture"),
    "workspace",
    "code",
    "12345678",
  );
  const name = "报告 # %.pdf";
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0xff]);
  for (const folder of [codeWorkspace, path.join(coworkWorkspace, "outputs")]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), bytes);
  }
  const code = {
    id: "code",
    mode: "code",
    cwd: codeWorkspace,
    environment: { kind: "space", spaceId: "s-fixture" },
  } as Conversation;
  const cowork = {
    id: "cowork",
    mode: "cowork",
    cwd: coworkWorkspace,
    environment: { kind: "space", spaceId: "c-fixture" },
  } as Conversation;
  store.conversations = [code, cowork];
  const ctx = {
    userId: 1,
    activeAccount: { id: owner },
    store,
    spaceRoot,
    signedOut: false,
    closedFlag: false,
    setAccessToken() {},
  };
  const modes: Mode[] = ["code", "cowork"];
  const dispatcher = {
    options: { officialUiRoot: "/fixture-assets" },
    guard: { modes },
    contextFor: async () => ctx,
    context: () => ctx,
    now: Date.now,
  } as unknown as Dispatcher;
  const read = (request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher, {
      method: "officialUiRead",
      user: { id: 1, accessToken: "fixture-token" },
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    read,
    async () => assert.fail("Workspace request escaped the runner bridge"),
  );
  const headers = { "x-organization-uuid": organization };
  const key = (session: Conversation) => cloudCodeSessionKey(session, owner);
  const sessionFile = (session: Conversation, file: string) =>
    `/v1/code/sessions/cse_${key(session)}/file?path=${encodeURIComponent(file)}`;
  const coworkPath = `/api/organizations/${organization}/cowork/sessions/session_${key(cowork)}/download-file?path=`;
  const remoteFile = `/mnt/user-data/outputs/${name}`;

  const codeAnswer = await fetch(sessionFile(code, name), { headers });
  assert.equal(codeAnswer.status, 200);
  assert.deepEqual(await codeAnswer.json(), {
    content: bytes.toString("base64"),
    content_type: "application/pdf",
  });
  const virtualAnswer = await fetch(sessionFile(code, `/workspace/${name}`), {
    headers,
  });
  assert.equal((await virtualAnswer.json()).content, bytes.toString("base64"));
  const coworkAnswer = await fetch(coworkPath + encodeURIComponent(remoteFile));
  assert.equal(coworkAnswer.status, 200);
  assert.match(
    coworkAnswer.headers.get("content-disposition")!,
    /^attachment;.*%E6%8A%A5/,
  );
  assert.deepEqual(Buffer.from(await coworkAnswer.arrayBuffer()), bytes);
  const coworkBrowser = await fetch(sessionFile(cowork, remoteFile), {
    headers,
  });
  assert.equal(coworkBrowser.status, 200);
  assert.equal((await coworkBrowser.json()).content, bytes.toString("base64"));

  const otherFile = path.join(coworkWorkspace, "outputs", name);
  fs.symlinkSync(otherFile, path.join(codeWorkspace, "linked.pdf"));
  for (const file of [
    otherFile,
    path.relative(codeWorkspace, otherFile),
    "linked.pdf",
    "missing.pdf",
    ".",
  ]) {
    assert.equal(
      (await fetch(sessionFile(code, file), { headers })).status,
      404,
    );
  }
  assert.equal(
    (
      await fetch(sessionFile(code, name), {
        headers: { "x-organization-uuid": organizationUuid("foreign") },
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(coworkPath.replace(key(cowork), key(code)) + name)).status,
    404,
  );
  assert.equal(
    (await fetch(coworkPath + encodeURIComponent(remoteFile) + "&path=extra"))
      .status,
    501,
  );
  const large = path.join(codeWorkspace, "large.pdf");
  fs.closeSync(fs.openSync(large, "w"));
  fs.truncateSync(large, 4 * 1024 * 1024);
  const refusal = await fetch(sessionFile(code, "large.pdf"), { headers });
  assert.equal(refusal.status, 400);
  assert.equal((await refusal.json()).error.reason, "session_file_too_large");
  fs.writeFileSync(large, bytes);
  assert.equal(
    (await fetch(sessionFile(code, "large.pdf"), { headers })).status,
    200,
  );
  modes.splice(0, 1);
  assert.equal((await fetch(sessionFile(code, name), { headers })).status, 404);
  ctx.signedOut = true;
  await assert.rejects(
    fetch(coworkPath + encodeURIComponent(remoteFile)),
    /session has ended/,
  );
});
