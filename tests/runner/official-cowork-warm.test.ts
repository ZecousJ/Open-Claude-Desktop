import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { openPolicy } from "../../shared/client-policy";
import { decodeWireValue } from "../../shared/web-wire";
import {
  claimOfficialCoworkWarm,
  discardOfficialCoworkWarm,
  reserveOfficialCoworkWarm,
  readOfficialCoworkWarm,
} from "../../runner/src/official-cowork-warm";

test("warm Cowork sessions stay out of history until a single claim", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cowork-warm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = "owner",
    identity = {};
  const store = {
    root,
    projects: [],
    conversations: [] as any[],
    settings: {
      activeProviderId: "p",
      providers: [{ id: "p", model: "m" }],
      codeEffort: "high",
    },
    async confirmOfficialCodeEvent() {},
  };
  const fileId = "a7ff6720-719e-4444-a12b-012c55524ea6";
  const filename = path.join(root, "attachments", fileId, "example.txt");
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, "document");
  const ctx = {
    activeAccount: { id: owner },
    store,
    selectedAttachments: new Map([
      [
        fileId,
        {
          id: fileId,
          name: "example.txt",
          path: filename,
          size: 8,
          kind: "text",
        },
      ],
    ]),
    policy: () => openPolicy,
    officialSessionIdentity: () => identity,
  };
  let sends = 0;
  const dispatcher = {
    async run(frame: any) {
      if (frame.method === "modelCatalog")
        return { items: [{ id: "m", efforts: ["high"] }] };
      const [input] = decodeWireValue(frame.args) as any[];
      assert.equal(input.attachments.length, 2);
      assert.equal(input.thinkingMode, "extended");
      assert.equal(input.coworkPermissionMode, "default");
      assert.equal(input.memoryDisabled, true);
      sends++;
      store.conversations.push({
        id: input.newConversationId,
        mode: "cowork",
        environment: { kind: "space" },
        model: input.model,
        memoryDisabled: input.memoryDisabled,
        coworkPermissionMode: input.coworkPermissionMode,
        turns: [{ prompt: input.text }],
      });
    },
  };
  const request = (value: unknown) => ({
    body: Buffer.from(JSON.stringify(value)),
    contentType: "application/json",
  });
  const frame = {
    user: { tabId: "tab_12345678" },
  };
  const reservation = reserveOfficialCoworkWarm(
    frame as never,
    ctx as never,
    organizationUuid(owner),
    request({
      title: "__warming__",
      model: "m",
      effort_level: "high",
      memory_mode: "disabled",
      surface: "hub",
      timezone: "Asia/Shanghai",
    }),
    () => true,
  )!;
  assert.equal(reservation.status, 200);
  assert.equal(store.conversations.length, 0);
  const session = JSON.parse(Buffer.from(reservation.body).toString()).session
    .id;
  const key = session.slice("session_".length);
  const placeholder = readOfficialCoworkWarm(
    frame as never,
    ctx as never,
    { kind: "session", key },
    undefined,
    () => true,
  );
  assert.equal(placeholder?.status, 200);
  const projected = JSON.parse(
    Buffer.from(placeholder!.body).toString(),
  ).session;
  assert.equal(projected.id, session);
  assert.equal(projected.worker_status, "running");
  assert.equal(projected.config.memory_mode, "MEMORY_MODE_DISABLED");
  const events = readOfficialCoworkWarm(
    frame as never,
    ctx as never,
    { kind: "events", key },
    undefined,
    () => true,
  )!;
  assert.deepEqual(JSON.parse(Buffer.from(events.body).toString()), {
    data: [],
    next_cursor: null,
  });
  const stream = readOfficialCoworkWarm(
    frame as never,
    ctx as never,
    { kind: "stream", key },
    undefined,
    () => true,
  )!;
  const streamBody = JSON.parse(Buffer.from(stream.body).toString());
  assert.equal(streamBody.session.worker_status, "running");
  assert.deepEqual(streamBody.data, []);

  assert.equal(store.conversations.length, 0);
  const payload = {
    events: [
      {
        payload: {
          type: "control_request",
          uuid: "f4ff6720-719e-4444-a12b-012c55524ea6",
          request_id: "initialize",
          request: { subtype: "initialize", rendersChromeSetupOffer: true },
        },
      },
      {
        payload: {
          type: "control_request",
          request_id: "permission",
          request: { subtype: "set_permission_mode", mode: "default" },
        },
      },
      {
        payload: {
          type: "control_request",
          request_id: "thinking",
          request: {
            subtype: "set_max_thinking_tokens",
            max_thinking_tokens: 31999,
          },
        },
      },
      {
        payload: {
          type: "user",
          uuid: "f4ff6720-719e-4444-a12b-012c55524ea6",
          session_id: session.replace("session_", "cse_"),
          parent_tool_use_id: null,
          shouldQuery: false,
          message: {
            role: "user",
            content:
              "<system-reminder>The user's timezone is Asia/Shanghai (currently UTC+8). Times the user mentions are in this timezone unless they say otherwise.</system-reminder>",
          },
        },
      },
      {
        payload: {
          type: "user",
          uuid: "d4ff6720-719e-4444-a12b-012c55524ea6",
          session_id: session.replace("session_", "cse_"),
          parent_tool_use_id: null,
          file_attachments: [
            { file_uuid: fileId, file_name: "example.txt", is_image: false },
          ],
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=",
                },
              },
              { type: "text", text: "Hello" },
            ],
          },
        },
      },
    ],
  };
  const claim = (value: unknown) =>
    claimOfficialCoworkWarm(
      dispatcher as never,
      frame as never,
      ctx as never,
      key,
      request(value),
      () => true,
    );
  const otherFrame = {
    user: { tabId: "tab_87654321" },
  };
  assert.equal(
    (
      await claimOfficialCoworkWarm(
        dispatcher as never,
        otherFrame as never,
        ctx as never,
        key,
        request(payload),
        () => true,
      )
    )?.status,
    409,
  );
  const otherSession = {
    user: { tabId: "tab_12345678", webSession: { id: "session-a" } },
  };
  assert.equal(
    (
      await claimOfficialCoworkWarm(
        dispatcher as never,
        otherSession as never,
        ctx as never,
        key,
        request(payload),
        () => true,
      )
    )?.status,
    409,
  );
  assert.equal(
    readOfficialCoworkWarm(
      otherFrame as never,
      ctx as never,
      { kind: "session", key },
      undefined,
      () => true,
    ),
    undefined,
  );
  const discardable = reserveOfficialCoworkWarm(
    frame as never,
    ctx as never,
    organizationUuid(owner),
    request({ title: "__warming__", model: "m", surface: "hub" }),
    () => true,
  )!;
  const discardKey = JSON.parse(Buffer.from(discardable.body).toString()).session
    .id.slice("session_".length);
  const discard = (caller: typeof frame, target: string, body = {}) =>
    discardOfficialCoworkWarm(caller as never, ctx as never, target, body, () => true);
  assert.equal(discard(otherFrame, discardKey)?.status, 409);
  assert.equal(discard(frame, discardKey, request({ invalid: true }))?.status, 400);
  assert.equal(discard(frame, discardKey, { body: Buffer.alloc(0), contentType: "" })?.status, 200);
  assert.equal(
    readOfficialCoworkWarm(frame as never, ctx as never,
      { kind: "session", key: discardKey }, undefined, () => true),
    undefined,
  );
  const first = await claim(payload);
  assert.equal(first?.status, 200);
  assert.deepEqual(await claim(payload), first);
  assert.equal(
    await claimOfficialCoworkWarm(
      dispatcher as never,
      otherFrame as never,
      ctx as never,
      key,
      request(payload),
      () => true,
    ),
    undefined,
  );
  assert.equal(
    await claim({
      events: [
        {
          payload: {
            ...payload.events[4]!.payload,
            uuid: "e4ff6720-719e-4444-a12b-012c55524ea6",
          },
        },
      ],
    }),
    undefined,
  );
  assert.equal(sends, 1);
  assert.equal(store.conversations.length, 1);
  assert.equal(discard(frame, key), undefined);
  assert.equal(
    readOfficialCoworkWarm(
      frame as never,
      ctx as never,
      { kind: "session", key },
      undefined,
      () => true,
    ),
    undefined,
  );
  assert.equal((await claim({ ...payload, events: [] }))?.status, 400);
  assert.equal(
    (
      await claim({
        events: [
          {
            payload: {
              ...payload.events[4]!.payload,
              message: { role: "user", content: "Changed" },
            },
          },
        ],
      })
    )?.status,
    409,
  );
});
