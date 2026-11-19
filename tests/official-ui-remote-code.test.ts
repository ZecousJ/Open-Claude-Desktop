import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReplyFeedback } from "../electron/conversations/reply-feedback";
import { Engine } from "../electron/engine/engine";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import {
  createOfficialRemoteCodeHost,
  type RemoteCodeHost,
} from "../electron/remote-control/official-code";
import { defaultSettings, Store } from "../electron/store/store";
import { CodeUltracodeUnavailable } from "../shared/code-session-settings";
import {
  createOfficialRemoteCodeController,
  usesRemoteCodeSessions,
} from "../shared/official-remote-code-controller";
import {
  remoteCodeArchivedInventoryPath,
  remoteCodeEnvironmentId,
  remoteCodeInventory,
  remoteCodeLinkTarget,
} from "../shared/official-remote-code";
import type { OfficialUiReadRequest } from "../shared/official-ui-web";
import { openOfficialCodeStream } from "../src-web/official/code-stream";
import type { AppEvent } from "../shared/types";
import type { Approval, Conversation, Provider } from "../shared/types";

const folder = "/remote/folder with spaces";
const device = "pc-0123456789";
const otherDevice = "pc-9876543210";
const owner = "active-owner";
const org = "active-organization";
const provider: Provider = {
  id: "provider",
  name: "Code provider",
  baseUrl: "https://openai.example.test",
  protocol: "responses",
  model: "gpt-5",
  models: ["gpt-5"],
};
const text = new TextEncoder();
const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));

function fixture(models = provider.models) {
  const conversations: Conversation[] = [];
  const approvals: Approval[] = [];
  const decisions: unknown[] = [];
  const stopped: string[] = [];
  const seen: string[] = [];
  const settings = {
    ...structuredClone(defaultSettings),
    providers: [{ ...provider, models }],
    activeProviderId: provider.id,
    remoteFolders: [folder],
    remoteControlNewSessions: false,
  };
  let online = true;
  let allowed = true;
  let inventoryOffline = false;
  let active = true;
  const current = () => {
    if (!active)
      throw new DOMException("The active account changed.", "AbortError");
  };
  const host: RemoteCodeHost = {
    account: () => ({ id: owner, name: "Owner", email: "owner@example.test" }),
    device: () => device,
    settings: () => settings,
    directory: () => "/not-needed",
    viewerScope: () => conversations,
    conversations: () => conversations,
    approvals: () => approvals,
    modelCatalog: (providerId) =>
      providerId === provider.id
        ? {
            defaultModel: provider.model,
            items: [
              {
                id: provider.model,
                displayName: provider.name,
                description: "",
                badges: [],
                sort: 0,
                hidden: false,
                isDefault: true,
                efforts: ["low", "high", "xhigh"],
                defaultEffort: "high",
                usageHint: "",
              },
            ],
          }
        : null,
    codeUltracodeAvailable: () => true,
    assertFolder: (cwd) => assert.equal(cwd, folder),
    create: (value) => conversations.push(value),
    send: async (input, uuid, lease) => {
      assert.equal(lease(), true);
      assert.equal(input.conversationId, conversations[0].id);
      seen.push(input.text);
      const now = Date.now();
      conversations[0].threadId = "real-thread";
      conversations[0].turns.push({
        id: "turn-" + seen.length,
        createdAt: now,
        prompt: input.text,
        officialCodeEventId: uuid,
        status: seen.length === 1 ? "completed" : "inProgress",
        attachments: [],
        items: [
          {
            id: "reply",
            type: "agentMessage",
            text: "Worked on the selected computer.",
            status: "completed",
          },
        ],
      });
    },
    update: async (id, patch) => {
      assert.equal(id, conversations[0].id);
      const { titleSource, ...changes } = patch;
      Object.assign(conversations[0], changes);
      if (titleSource === "user") conversations[0].titleSetByUser = true;
    },
    delete: async (id, lease) => {
      const index = conversations.findIndex((c) => c.id === id);
      if (!lease() || index === -1) throw Error("Code session changed.");
      conversations.splice(index, 1);
    },
    saveCodeFlags: async (conversation, choice, current) => {
      assert.equal(conversation, conversations[0]);
      assert.equal(current(), true);
      if (choice.codeUltracode && !host.codeUltracodeAvailable(conversation))
        throw new CodeUltracodeUnavailable();
      Object.assign(conversation, choice);
    },
    interrupt: async (id, target) => {
      assert.equal(id, conversations[0].id);
      stopped.push(target.turnId);
      return { status: "accepted" };
    },
    approve: async (id, response) => decisions.push([id, response]),
  };
  const handle = createOfficialRemoteCodeHost(host);
  const freshController = (legacyArchivedInventory = false) =>
    createOfficialRemoteCodeController({
      list: async () => [
        {
          id: device,
          online,
          name: "Remote computer",
          platform: "darwin",
          version: "1",
          connectedAt: "",
        },
        {
          id: otherDevice,
          online: false,
          name: "Other computer",
          platform: "win32",
          version: "1",
          connectedAt: "",
        },
      ],
      call: async (target, request) => {
        if (!allowed) throw Error("Approve this device in Settings.");
        if (target !== device || !online)
          throw Error("This computer is not online.");
        const { pathname, search } = new URL(request.path, "http://localhost");
        const inventory = request.method === "GET" && pathname === "/v1/code/sessions";
        if (legacyArchivedInventory && inventory && search)
          return {
            status: request.path === remoteCodeArchivedInventoryPath ? 404 : 501,
            value: {},
          };
        if (inventoryOffline && inventory)
          throw Object.assign(Error("This computer is not online."), {
            code: "CLAUDEX_DEVICE_OFFLINE",
          });
        return handle(
          request,
          () => active && allowed,
          () => ({ active: 0, max: 32 }),
        );
      },
    });
  const controller = freshController();
  const envs = () => controller.environments(current);
  const request = async (
    method: OfficialUiReadRequest["method"],
    path: string,
    body?: unknown,
    options: {
      organization?: string;
      link?: URL;
      controller?: typeof controller;
      cloud?:
        | { status: number; value: unknown }
        | ((path: string) => { status: number; value: unknown });
    } = {},
  ) => {
    const answer = await (options.controller ?? controller).request(
      {
        method,
        path,
        codeOrganizationId: options.organization ?? org,
        ...(body !== undefined && { body: text.encode(JSON.stringify(body)) }),
      },
      {
        current,
        organization: org,
        hint: options.link && remoteCodeLinkTarget(options.link),
        fallback: async (override = path) => {
          const cloud = typeof options.cloud === "function"
            ? options.cloud(override)
            : options.cloud;
          return cloud && {
            status: cloud.status,
            contentType: "application/json",
            body: text.encode(JSON.stringify(cloud.value)),
          };
        },
      },
    );
    assert.ok(answer);
    return {
      status: answer.status,
      value: answer.body.length ? decode(answer.body) : null,
    };
  };
  const create = async (
    environmentId = remoteCodeEnvironmentId(device, folder),
  ) =>
    request("POST", "/v1/code/sessions", {
      title: "Remote Code session",
      environment_id: environmentId,
      config: {
        sources: [],
        outcomes: [],
        permission_mode: "default",
        model: provider.model,
      },
      events: [],
      tags: ["remote-control-app"],
    });
  return {
    controller,
    freshController,
    handle,
    envs,
    request,
    create,
    host,
    seen,
    stopped,
    approvals,
    decisions,
    disconnect: () => {
      online = false;
    },
    reconnect: () => {
      online = true;
    },
    setInventoryOffline: (value: boolean) => {
      inventoryOffline = value;
    },
    revoke: () => {
      allowed = false;
    },
    retire: () => {
      active = false;
    },
  };
}

test("the official Code picker projects a signed computer's actual permitted folder and creates there", async () => {
  const f = fixture();
  const rows = await f.envs();
  assert.deepEqual(
    rows.map(({ bridge_info }) => bridge_info),
    [
      {
        machine_name: "Remote computer",
        directory: folder,
        online: true,
        max_sessions: 32,
        active_sessions: 0,
      },
      {
        machine_name: "Other computer",
        online: false,
        max_sessions: 0,
        active_sessions: 0,
      },
    ],
  );
  assert.equal(
    (await f.create(remoteCodeEnvironmentId(device, "/not-allowed"))).status,
    403,
  );
  assert.equal(f.host.conversations().length, 0);
  const created = await f.create(rows[0].environment_id);
  assert.equal(created.status, 200);
  assert.equal(f.host.conversations()[0].cwd, folder);
  assert.equal(f.host.conversations()[0].remoteControlOff, undefined);
  assert.equal(created.value.session.environment_kind, "bridge");
  assert.match(created.value.session.id, /^session_[a-f0-9]{32}$/);
  assert.equal(f.seen.length, 0);
});

test("the original Code title update and rename receipt agree on the explicit saved title", async () => {
  const f = fixture();
  const { value: { session } } = await f.create();
  const path = "/v1/code/sessions/" + session.id.replace("session_", "cse_");
  const [conversation] = f.host.conversations();
  delete conversation.titleSetByUser;
  const receipt = (title: string) => ({
    events: [{
      payload: {
        uuid: crypto.randomUUID(),
        type: "control_request",
        request_id: "rename-session-" + crypto.randomUUID(),
        request: { subtype: "rename_session", title },
      },
    }],
  });
  const acknowledge = (title: string) =>
    f.request("POST", path + "/events", receipt(title));

  assert.equal((await acknowledge(session.title)).status, 409);
  for (const body of [{ title: " " }, { title: "x".repeat(201) }, { title: "a", pinned: true }])
    assert.equal((await f.request("PUT", path, body)).status, 400);
  const renamed = await f.request("PUT", path, { title: "  My Code session  " });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.value.session.title, "My Code session");
  assert.equal((await f.request("GET", path)).value.session.title, "My Code session");

  f.host.update = async () => { throw Error("The host could not save the title."); };
  assert.equal((await f.request("PUT", path, { title: "Unsaved" })).status, 409);
  assert.equal((await acknowledge("Unsaved")).status, 409);
  assert.equal((await acknowledge(session.title)).status, 409);
  assert.deepEqual(await acknowledge("My Code session"), { status: 200, value: { events: [] } });
  assert.equal((await f.request("GET", path)).value.session.title, "My Code session");
});

test("the original Code deletion removes only an eligible session on the selected computer", async () => {
  const f = fixture();
  const { value: { session } } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  assert.equal((await f.request("DELETE", path)).status, 400);
  assert.equal((await f.request("DELETE", path, { force: true })).status, 400);

  const keptId = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  const [conversation] = f.host.conversations();
  f.host.conversations().push(
    { ...conversation, id: keptId },
    {
      ...conversation,
      id: foreignId,
      sessionAuthors: { ownerAccountUuid: "foreign", viewerAccountUuid: owner },
    },
  );
  const foreign = "session_" + foreignId.replaceAll("-", "");
  assert.equal((await f.request("DELETE", "/v1/code/sessions/" + foreign, {}, {
    link: new URL(`https://example.test/code/${foreign}?device=${device}`),
  })).status, 404);

  await f.envs();
  assert.deepEqual(await f.request("DELETE", path, {}), { status: 200, value: {} });
  f.disconnect();
  const offline = await f.request("GET", "/v1/code/sessions?limit=50");
  assert.deepEqual(offline.value.data.map(({ id }: { id: string }) => id), [
    "session_" + keptId.replaceAll("-", ""),
  ]);
  f.reconnect();
  assert.equal((await f.request("GET", path)).status, 404);
  assert.equal((await f.request("DELETE", path, {})).status, 404);
  assert.deepEqual(f.host.conversations().map(({ id }) => id), [keptId, foreignId]);
});

test("Code deletion preserves a session during dispatch, while work is staged, or if its lease is lost", async () => {
  const f = fixture();
  const { value: { session } } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const [conversation] = f.host.conversations();
  let sending = () => {};
  let finishSend = () => {};
  const sendStarted = new Promise<void>((resolve) => { sending = resolve; });
  const sendFinished = new Promise<void>((resolve) => { finishSend = resolve; });
  f.host.send = async () => {
    sending();
    await sendFinished;
  };
  const sent = f.request("POST", path + "/events", {
    events: [{
      payload: {
        type: "user",
        uuid: crypto.randomUUID(),
        message: { role: "user", content: "Start the task" },
      },
    }],
  });
  await sendStarted;
  const whileSending = await f.request("DELETE", path, {});
  finishSend();
  assert.equal(whileSending.status, 409);
  assert.equal((await sent).status, 200);

  conversation.codeNewTask = {
    id: "staged",
    text: "Work staged on the computer",
    attachments: [],
    providerId: provider.id,
    model: provider.model,
  };
  assert.equal((await f.request("DELETE", path, {})).status, 409);
  delete conversation.codeNewTask;

  conversation.turns.push({
    id: "running",
    createdAt: Date.now(),
    prompt: "Work running on the computer",
    status: "inProgress",
    attachments: [],
    items: [],
  });
  assert.equal((await f.request("DELETE", path, {})).status, 409);
  conversation.turns[0].status = "completed";
  assert.deepEqual(f.stopped, []);

  const remove = f.host.delete;
  f.host.delete = async (id, lease) => {
    f.revoke();
    await remove(id, lease);
  };
  assert.equal((await f.request("DELETE", path, {})).status, 409);
  assert.deepEqual(f.host.conversations(), [conversation]);
});

test("original Code create and follow-up requests reopen the same history, acknowledge retries and stop the exact turn", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const make = (message: string) => ({
    events: [
      {
        payload: {
          type: "user",
          uuid: crypto.randomUUID(),
          session_id: session.id,
          parent_tool_use_id: null,
          message: { role: "user", content: [{ type: "text", text: message }] },
        },
      },
    ],
  });
  const first = make("Check the remote repo");
  assert.equal((await f.request("POST", path + "/events", first)).status, 200);
  assert.equal((await f.request("POST", path + "/events", first)).status, 200);
  assert.equal(
    (
      await f.request(
        "GET",
        path + "/events/" + first.events[0].payload.uuid + "/receipt",
      )
    ).status,
    204,
  );
  const firstPage = await f.request("GET", path + "/events?limit=50");
  assert.equal(firstPage.value.data[0].payload.session_id, session.id);
  assert.match(
    JSON.stringify(firstPage.value.data),
    /Worked on the selected computer/,
  );
  f.controller.clear();
  const direct = new URL(
    "https://example.test/code/" + session.id + "?device=" + device,
  );
  assert.equal(
    (await f.request("GET", path, undefined, { link: direct })).value.session
      .title,
    "Remote Code session",
  );
  assert.equal(
    (
      await f.request("GET", path, undefined, {
        link: direct,
        organization: "different",
      })
    ).status,
    404,
  );
  direct.searchParams.set("device", otherDevice);
  assert.equal(
    (await f.request("GET", path, undefined, { link: direct })).status,
    503,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        path + "/events",
        make("Continue on the same computer"),
      )
    ).status,
    200,
  );
  const stream = await f.request(
    "GET",
    path + "/events/stream?from_sequence_num=0",
  );
  assert.equal(stream.value.conversation_id, f.host.conversations()[0].id);
  assert.equal(stream.value.session.worker_status, "running");
  const stop = stream.value.session.claudex_stop_target.target;
  assert.equal(
    (
      await f.request("POST", path + "/events", {
        events: [
          {
            payload: {
              type: "control_request",
              request_id: "stop",
              request: { subtype: "interrupt", turn_target: stop },
            },
          },
        ],
      })
    ).status,
    200,
  );
  assert.deepEqual(f.stopped, ["turn-2"]);
  assert.deepEqual(f.seen, [
    "Check the remote repo",
    "Continue on the same computer",
  ]);
});

const flagSettings = (settings: object) => ({
  payload: {
    type: "control_request",
    request_id: crypto.randomUUID(),
    request: { subtype: "apply_flag_settings", settings },
  },
});

test("the signed Code bridge rejects a drawing model from an out-of-date picker", async () => {
  const drawing = "gpt-image-2.5";
  const f = fixture([...provider.models, drawing]);
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const result = await f.request("POST", path + "/events", {
    events: [{
      payload: {
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "set_model", model: drawing },
      },
    }],
  });
  assert.equal(result.status, 400);
  assert.equal((await f.request("GET", path)).value.session.config.model, provider.model);
});

test("the signed Code bridge saves Ultracode separately from ordinary effort", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const flags = async (settings: object) =>
    f.request("POST", path + "/events", { events: [flagSettings(settings)] });
  const read = async () => (await f.request("GET", path)).value.session;

  assert.equal((await flags({ effortLevel: "low", ultracode: true })).status, 200);
  const enabled = await read();
  assert.equal(enabled.config.effort_level, "low");
  assert.equal(enabled.external_metadata.is_ultracode_active, true);

  assert.equal((await flags({ ultracode: false })).status, 200);
  const disabled = await read();
  assert.equal(disabled.config.effort_level, "low");
  assert.equal(disabled.external_metadata.is_ultracode_active, false);

  assert.equal((await flags({ effortLevel: "xhigh" })).status, 200);
  const higher = await read();
  assert.equal(higher.config.effort_level, "xhigh");
  assert.equal(higher.external_metadata.is_ultracode_active, false);

  assert.equal((await flags({ effortLevel: null, ultracode: true })).status, 200);
  const reset = await read();
  assert.equal(reset.config.effort_level, "high");
  assert.equal(reset.external_metadata.is_ultracode_active, true);

  f.host.codeUltracodeAvailable = () => false;
  assert.equal((await flags({ effortLevel: "low", ultracode: true })).status, 409);
  const unavailable = await read();
  assert.equal(unavailable.config.effort_level, "high");
  assert.equal(unavailable.external_metadata.is_ultracode_active, false);
});

test("the signed Code bridge rejects a Fast mode batch before sending any message", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const user = {
    payload: {
      type: "user",
      uuid: crypto.randomUUID(),
      message: { role: "user", content: "Check the remote repo" },
    },
  };
  const failed = await f.request("POST", path + "/events", {
    events: [
      flagSettings({ effortLevel: "low" }),
      user,
      flagSettings({ fastMode: true }),
    ],
  });
  assert.equal(failed.status, 409);
  assert.match(failed.value.error.message, /Fast mode is unavailable/);
  assert.deepEqual(f.seen, []);
  assert.equal(
    (await f.request("GET", path)).value.session.config.effort_level,
    undefined,
  );

  const accepted = await f.request("POST", path + "/events", {
    events: [flagSettings({ fastMode: false }), user],
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(f.seen, ["Check the remote repo"]);
});

test("offline and revoked devices give different environment and history outcomes", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  await f.envs();
  f.disconnect();
  const offline = await f.envs();
  assert.equal(offline[0].bridge_info.directory, folder);
  assert.equal(offline[0].bridge_info.online, false);
  assert.equal(
    (await f.request("GET", "/v1/code/sessions?limit=50")).value.data[0]
      .connection_status,
    "disconnected",
  );
  f.reconnect();
  f.revoke();
  assert.equal((await f.envs())[0].bridge_info.directory, undefined);
  const link = new URL(
    "https://example.test/code/" + session.id + "?device=" + device,
  );
  assert.equal(
    (
      await f.request("GET", "/v1/code/sessions/" + session.id, undefined, {
        link,
      })
    ).status,
    403,
  );
  f.retire();
  await assert.rejects(f.envs(), /active account changed/);
});

test("a fresh Code client lists, opens and restores an archived remote worktree", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-code-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const workspace = path.join(root, "worktree");
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "note.txt"), "Saved on the computer.\n");
  git("add", "note.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Add note",
  );
  git("worktree", "add", "-b", "session", workspace);

  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const [conversation] = f.host.conversations();
  conversation.cwd = workspace;
  conversation.worktree = {
    repository: repo,
    origin: repo,
    path: workspace,
    branch: "session",
    name: "session",
  };
  const store = new Store(root);
  store.conversations.push(conversation);
  store.flush();
  let update: ((...args: unknown[]) => unknown) | undefined;
  registerConversationManageHandlers({
    context: {
      store,
      engine: new Engine(
        store,
        "unused",
        () => "",
        () => {},
      ),
      replyFeedback: new ReplyFeedback(root),
      activeAccount: { id: owner },
      accountGeneration: () => 1,
      selectedAttachments: new Map(),
      allowedFolder: () => {},
      noActive: () => {},
    },
    engineOf: () => undefined,
    handle: (name, handler) => {
      if (name === "updateConversation") update = handler;
    },
  });
  f.host.update = async (id, patch) => {
    assert.ok(update);
    return update(id, patch);
  };

  const detail = "/v1/code/sessions/" + session.id;
  const archivePage = "/v1/code/sessions?statuses=archived&limit=50";
  const activePage = "/v1/code/sessions?statuses=active&statuses=paused&limit=50";
  const cloudList = { status: 200, value: { data: [], next_cursor: null } };
  const cloudMiss = {
    status: 404,
    value: { error: { type: "not_found_error" } },
  };
  const archived = await f.request("POST", detail + "/archive");
  assert.equal(archived.value.session.status, "archived");
  assert.equal(
    new Store(root).conversation(conversation.id).worktree?.state,
    "deleted",
  );
  assert.equal(fs.existsSync(workspace), false);

  const history = f.freshController();
  const list = (url: string) =>
    f.request("GET", url, undefined, { controller: history, cloud: cloudList });
  assert.deepEqual((await list(activePage)).value.data, []);
  assert.equal((await list(archivePage)).value.data[0].id, session.id);
  const open = await f.request("GET", detail, undefined, {
    controller: f.freshController(),
    cloud: cloudMiss,
  });
  assert.equal(open.status, 200);
  assert.equal(open.value.session.status, "archived");

  f.disconnect();
  assert.equal(
    (await list(archivePage)).value.data[0].connection_status,
    "disconnected",
  );
  assert.deepEqual((await list(activePage)).value.data, []);
  f.reconnect();
  const restored = await f.request(
    "POST",
    detail + "/unarchive",
    {},
    {
      controller: f.freshController(),
    },
  );
  assert.equal(restored.value.session.status, "active");
  assert.equal(new Store(root).conversation(conversation.id).archived, false);
  assert.equal(
    fs.readFileSync(path.join(workspace, "note.txt"), "utf8"),
    "Saved on the computer.\n",
  );
  assert.equal((await list(activePage)).value.data[0].id, session.id);
  f.disconnect();
  assert.deepEqual((await list(archivePage)).value.data, []);
});

test("Code history resumes a page after either a signed-device or a cloud session", async () => {
  const f = fixture();
  await f.create();
  const [template] = f.host.conversations();
  const saved = (id: number, updatedAt: number, pinned = false) => ({
    ...template,
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    archived: true,
    pinned,
    updatedAt,
  });
  const sessionId = ({ id }: { id: string }) =>
    "session_" + id.replaceAll("-", "");
  const firstRemote = saved(1, 4000);
  const lastRemote = saved(2, 2000, true);
  f.host.conversations().splice(0, 1, firstRemote, lastRemote);

  const cloudRow = (id: string, updatedAt: number, pinned = false) => ({
    id: "session_" + id.repeat(32),
    last_event_at: new Date(updatedAt).toISOString(),
    tags: pinned ? ["ui:pinned"] : [],
  });
  const firstCloud = cloudRow("f", 4000, true);
  const lastCloud = cloudRow("b", 4000);
  const cloudRows = [firstCloud, lastCloud, cloudRow("a", 1000, true)];
  const cloud = (path: string) => {
    const q = new URL(path, "http://localhost").searchParams;
    const limit = Number(q.get("limit") ?? 50);
    const cursor = q.get("cursor");
    const offset = cursor
      ? cloudRows.findIndex(({ id }) => id === cursor) + 1
      : 0;
    if (cursor && !offset) return { status: 404, value: {} };
    const data = cloudRows.slice(offset, offset + limit);
    const pinned =
      !cursor && q.get("include_pinned_beyond_page") === "true"
        ? cloudRows
            .slice(limit)
            .filter(({ tags }) => tags.includes("ui:pinned"))
        : [];
    return {
      status: 200,
      value: {
        data,
        next_cursor: offset + limit < cloudRows.length ? data.at(-1)?.id : null,
        ...(pinned.length && { pinned_beyond_page: { sessions: pinned } }),
      },
    };
  };
  const list = (limit: number, cursor?: string, pinned = false) =>
    f.request(
      "GET",
      `/v1/code/sessions?statuses=archived&limit=${limit}` +
        (cursor ? "&cursor=" + cursor : "") +
        (pinned ? "&include_pinned_beyond_page=true" : ""),
      undefined,
      { cloud },
    );

  const initial = (await list(1, undefined, true)).value;
  assert.deepEqual(
    initial.data.map(({ id }: { id: string }) => id),
    [firstCloud.id],
  );
  assert.equal(initial.next_cursor, firstCloud.id);
  assert.deepEqual(
    initial.pinned_beyond_page.sessions.map(({ id }: { id: string }) => id),
    [sessionId(lastRemote), cloudRows[2].id],
  );
  const middle = (await list(2, initial.next_cursor, true)).value;
  assert.deepEqual(
    middle.data.map(({ id }: { id: string }) => id),
    [lastCloud.id, sessionId(firstRemote)],
  );
  assert.equal(middle.next_cursor, sessionId(firstRemote));
  assert.equal(middle.pinned_beyond_page, undefined);
  const last = (await list(2, middle.next_cursor)).value;
  assert.deepEqual(
    last.data.map(({ id }: { id: string }) => id),
    [sessionId(lastRemote), cloudRows[2].id],
  );
  assert.equal(last.next_cursor, null);
  assert.equal((await list(2, "session_missing")).status, 404);

  const displaced = (await list(4, undefined, true)).value;
  assert.deepEqual(
    displaced.pinned_beyond_page.sessions.map(({ id }: { id: string }) => id),
    [cloudRows[2].id],
  );
});

test("signed-device Code history can page beyond the first inventory and retain its known rows offline", async () => {
  const f = fixture();
  await f.create();
  const [template] = f.host.conversations();
  const rows = Array.from({ length: 105 }, (_, index) => ({
    ...template,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    updatedAt: template.createdAt + 105 - index,
    archived: true,
  }));
  f.host.conversations().splice(0, 1, ...rows);
  const ids = rows.map(({ id }) => "session_" + id.replaceAll("-", ""));
  const cloud = { status: 503, value: { error: "Cloud Code is unavailable." } };
  const list = (cursor?: string, archived = true) =>
    f.request(
      "GET",
      "/v1/code/sessions?limit=50" +
        (archived ? "&statuses=archived" : "") +
        (cursor ? "&cursor=" + cursor : ""),
      undefined,
      { cloud },
    );

  const legacy = await f.handle(
    { method: "GET", path: remoteCodeArchivedInventoryPath },
    () => true,
    () => ({ active: 0, max: 32 }),
  );
  assert.equal(legacy.status, 200);
  assert.equal(remoteCodeInventory.parse(legacy.value).sessions.length, 100);

  const first = (await list(undefined, false)).value;
  assert.deepEqual(
    first.data.map(({ id }: { id: string }) => id),
    ids.slice(0, 50),
  );
  assert.equal(first.next_cursor, ids[49]);

  f.disconnect();
  assert.equal((await list(first.next_cursor)).status, 503);
  f.reconnect();
  const second = (await list(first.next_cursor)).value;
  assert.deepEqual(
    second.data.map(({ id }: { id: string }) => id),
    ids.slice(50, 100),
  );
  assert.equal(second.next_cursor, ids[99]);

  f.disconnect();
  const last = (await list(second.next_cursor)).value;
  assert.deepEqual(
    last.data.map(({ id }: { id: string }) => id),
    ids.slice(100),
  );
  assert.ok(
    last.data.every(
      (row: { connection_status: string }) =>
        row.connection_status === "disconnected",
    ),
  );
  assert.equal(last.next_cursor, null);
});

test("older remote receivers keep active history and support new clients opening archived sessions", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const detail = "/v1/code/sessions/" + session.id;
  assert.equal((await f.request("POST", detail + "/archive", {})).status, 200);
  const [conversation] = f.host.conversations();
  const activeId = crypto.randomUUID();
  f.host
    .conversations()
    .push({ ...conversation, id: activeId, archived: false });
  const activeWireId = "session_" + activeId.replaceAll("-", "");

  const controller = f.freshController(true);
  const cloud = { status: 200, value: { data: [], next_cursor: null } };
  const list = (url: string) =>
    f.request("GET", url, undefined, { controller, cloud });
  const mixed = "/v1/code/sessions?statuses=archived&statuses=active&limit=50";
  assert.equal((await list(mixed)).value.data[0].id, activeWireId);
  assert.deepEqual(
    (await list("/v1/code/sessions?statuses=archived")).value.data,
    [],
  );
  f.disconnect();
  assert.equal(
    (await list(mixed)).value.data[0].connection_status,
    "disconnected",
  );
  f.reconnect();
  assert.equal(
    (await f.request("GET", detail, undefined, { controller })).value.session
      .status,
    "archived",
  );
  const restored = await f.request(
    "POST",
    detail + "/unarchive",
    {},
    {
      controller: f.freshController(true),
    },
  );
  assert.equal(restored.value.session.status, "active");
});

test("Code heartbeat distinguishes a signed session, a disconnected computer, and unknown IDs", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/heartbeat_check";
  const id = session.id.replace("session_", "cse_");
  const unknown = "cse_" + "f".repeat(32);
  const cloud = "cse_" + "1".repeat(32);
  f.host.conversations().push({
    ...f.host.conversations()[0],
    id: "11111111-1111-1111-1111-111111111111",
    cloudHosted: true,
  });
  const heartbeat = () =>
    f.request("POST", path, { session_ids: [unknown, id, cloud, id] });
  const expected = (outcome: "fresh" | "no_worker" | "unknown") => ({
    status: 200,
    value: {
      checks_enabled: true,
      results: [
        { session_id: unknown, outcome: "unknown" },
        { session_id: id, outcome },
        { session_id: cloud, outcome: "unknown" },
        { session_id: id, outcome },
      ],
    },
  });

  f.disconnect();
  assert.deepEqual(await heartbeat(), expected("unknown"));
  f.reconnect();
  assert.deepEqual(await heartbeat(), expected("fresh"));

  f.setInventoryOffline(true);
  assert.deepEqual(await heartbeat(), expected("unknown"));
  f.disconnect();
  assert.deepEqual(await heartbeat(), expected("no_worker"));

  f.reconnect();
  f.setInventoryOffline(false);
  assert.deepEqual(await heartbeat(), expected("fresh"));
  assert.equal(
    (await f.request("POST", "/v1/code/sessions/" + id + "/archive")).status,
    200,
  );
  f.disconnect();
  assert.deepEqual(await heartbeat(), expected("unknown"));

  f.reconnect();
  assert.equal(
    (await f.request("POST", "/v1/code/sessions/" + id + "/unarchive")).status,
    200,
  );
  assert.deepEqual(await heartbeat(), expected("fresh"));
  f.revoke();
  assert.deepEqual(await heartbeat(), expected("unknown"));
});

test("Code heartbeat checks the exact route, account scope, and batch before probing", async () => {
  const path = "/v1/code/sessions/heartbeat_check";
  const id = "cse_" + "a".repeat(32);
  let listed = 0;
  const controller = createOfficialRemoteCodeController({
    list: async () => {
      listed++;
      return [];
    },
    call: async () => assert.fail("invalid heartbeat must not call a computer"),
  });
  const op = {
    current: () => {},
    organization: org,
    fallback: async () => assert.fail("heartbeat must not use cloud history"),
  };
  const body = text.encode(JSON.stringify({ session_ids: [id] }));

  assert.equal(usesRemoteCodeSessions("POST", path), true);
  assert.equal(usesRemoteCodeSessions("GET", path), false);
  assert.equal(usesRemoteCodeSessions("POST", path, "?probe=1"), false);
  assert.equal(usesRemoteCodeSessions("POST", path + "/"), false);
  assert.equal(
    await controller.request(
      { method: "POST", path: path + "?probe=1", body },
      op,
    ),
    undefined,
  );
  assert.equal(
    await controller.request({ method: "GET", path }, op),
    undefined,
  );

  for (const codeOrganizationId of [
    undefined,
    "other-organization",
    org.toUpperCase(),
  ]) {
    const answer = await controller.request(
      { method: "POST", path, body, codeOrganizationId },
      op,
    );
    assert.equal(answer?.status, 404);
  }
  for (const raw of [
    undefined,
    text.encode("{"),
    text.encode(JSON.stringify({})),
    text.encode(JSON.stringify({ session_ids: ["session_" + "a".repeat(32)] })),
    text.encode(JSON.stringify({ session_ids: [id.toUpperCase()] })),
    text.encode(JSON.stringify({ session_ids: Array(26).fill(id) })),
  ]) {
    const answer = await controller.request(
      {
        method: "POST",
        path,
        body: raw,
        codeOrganizationId: org,
      },
      op,
    );
    assert.equal(answer?.status, 400);
  }
  const empty = await controller.request(
    {
      method: "POST",
      path,
      body: text.encode('{"session_ids":[]}'),
      codeOrganizationId: org,
    },
    op,
  );
  assert.equal(empty?.status, 200);
  assert.deepEqual(empty && decode(empty.body), {
    checks_enabled: true,
    results: [],
  });
  assert.equal(listed, 0);
});

test("the original Code approval panel can decline a command on its owning computer", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const conversation = f.host.conversations()[0];
  f.approvals.push({
    id: 246,
    conversationId: conversation.id,
    method: "item/commandExecution/requestApproval",
    params: { command: "mkdir verify-this-command" },
  });
  const stream = await f.request(
    "GET",
    path + "/events/stream?from_sequence_num=0",
  );
  const [control] = stream.value.controls;
  assert.equal(control.request.tool_name, "Bash");
  assert.equal(control.request.input.command, "mkdir verify-this-command");
  assert.equal(
    (
      await f.request("POST", path + "/events", {
        events: [
          {
            payload: {
              type: "control_response",
              uuid: crypto.randomUUID(),
              response: {
                subtype: "success",
                request_id: control.request_id,
                response: {
                  behavior: "deny",
                  toolUseID: control.request.tool_use_id,
                  message: "Do not run this command.",
                },
              },
            },
          },
        ],
      })
    ).status,
    200,
  );
  assert.deepEqual(f.decisions, [[246, { decision: "decline" }]]);
});

test("the original SSE client initializes cse sessions and stops its own running input", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const alias = session.id.replace(/^session_/, "cse_");
  const path = "/v1/code/sessions/" + alias;
  const event = (request: object) => ({
    session_id: alias,
    events: [
      {
        payload: {
          request_id: "1foxcnq3xvf",
          type: "control_request",
          request,
          uuid: crypto.randomUUID(),
        },
      },
    ],
  });
  const initial = await f.request(
    "POST",
    path + "/events",
    event({ subtype: "initialize" }),
  );
  assert.equal(initial.status, 200);
  assert.equal(initial.value.requestId, "1foxcnq3xvf");
  assert.deepEqual(
    initial.value.response.models.map(({ value }: { value: string }) => value),
    [provider.model],
  );
  const tokens = {
    totalTokens: 100,
    inputTokens: 80,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  f.host.conversations()[0].tokenUsage = {
    total: tokens,
    last: tokens,
    modelContextWindow: 1_000,
  };
  const usage = await f.request(
    "POST",
    path + "/events",
    event({ subtype: "get_context_usage" }),
  );
  assert.equal(usage.status, 200);
  assert.equal(usage.value.response.percentage, 10);
  const prompt = (uuid: string, content: string) => ({
    session_id: alias,
    events: [
      {
        payload: {
          type: "user",
          uuid,
          session_id: alias,
          message: { role: "user", content },
        },
      },
    ],
  });
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  assert.equal(
    (await f.request("POST", path + "/events", prompt(first, "First"))).status,
    200,
  );
  assert.equal(
    (await f.request("POST", path + "/events", prompt(second, "Continuation")))
      .status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        path + "/events",
        event({
          subtype: "interrupt",
          starting_input_uuid: first,
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        path + "/events",
        event({
          subtype: "interrupt",
          starting_input_uuid: second,
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(f.stopped, ["turn-2"]);
});

test("the original SSE composer receives active status even before the remote engine emits text", async () => {
  const f = fixture();
  const {
    value: { session },
  } = await f.create();
  const path = "/v1/code/sessions/" + session.id;
  const send = async (prompt: string) =>
    f.request("POST", path + "/events", {
      events: [
        {
          payload: {
            type: "user",
            uuid: crypto.randomUUID(),
            message: { role: "user", content: prompt },
          },
        },
      ],
    });
  await send("Prior completed turn");
  await send("Running without a model frame");
  const conversation = f.host.conversations()[0];
  const running = conversation.turns.at(-1);
  assert.ok(running);
  running.items = [];
  const key = session.id.slice("session_".length);
  const url = new URL(path + "/events/stream", "https://example.test");
  let changed: ((event: AppEvent) => void) | undefined;
  const response = await openOfficialCodeStream(
    new Request(url),
    url,
    { kind: "stream", key, from: 0 },
    async ({ path }) => {
      const answer = await f.request("GET", path);
      return {
        status: answer.status,
        contentType: "application/json",
        body: text.encode(JSON.stringify(answer.value)),
      };
    },
    (notify) => {
      changed = notify;
      return () => {
        changed = undefined;
      };
    },
  );
  const reader = response.body?.getReader();
  assert.ok(reader);
  try {
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(
      initial,
      /"type":"result".*"subtype":"status","status":"requesting"/s,
    );
    assert.match(
      initial,
      /"type":"message_start","message":\{"id":"turn-2:waiting"/,
    );
    running.status = "interrupted";
    running.userStopped = true;
    changed?.({ type: "remote-code-changed", conversationId: conversation.id });
    const stopped = new TextDecoder().decode((await reader.read()).value);
    assert.match(stopped, /"worker_status":"idle"/);
    assert.match(stopped, /"subtype":"status","status":null/);
  } finally {
    await reader.cancel();
  }
});

test("remote worktree receipts distinguish failed preparation from an uncertain dispatch", async () => {
  const f = fixture();
  const { value: { session } } = await f.create();
  const conversation = f.host.conversations()[0];
  conversation.remoteCodeWorktree = { origin: folder };
  const originalSend = f.host.send;
  f.host.send = async (input, uuid) => {
    conversation.turns.push({ id: "pending-first", prompt: input.text,
      officialCodeEventId: uuid, remoteCodeDispatchState: "preparing", status: "failed",
      error: "Git failed", createdAt: Date.now(), attachments: [], items: [] });
  };
  const path = `/v1/code/sessions/${session.id}`;
  const message = (uuid: string) => ({ events: [{ payload: { type: "user", uuid,
    session_id: session.id, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "hello" }] } } }] });
  const first = crypto.randomUUID();
  assert.equal((await f.request("POST", path + "/events", message(first))).status, 409);
  assert.equal((await f.request("GET", path + `/events/${first}/receipt`)).status, 404);
  assert.equal((await f.request("POST", path + "/events", message(first))).status, 409);
  f.host.send = originalSend;
  assert.equal((await f.request("POST", path + "/events", message(crypto.randomUUID()))).status, 200);
  const attempted = crypto.randomUUID();
  conversation.turns.push({ id: "pending-ambiguous", prompt: "unknown", officialCodeEventId: attempted,
    remoteCodeDispatchState: "attempted", status: "interrupted", stopReason: "restart", createdAt: Date.now(), attachments: [], items: [] });
  assert.equal((await f.request("POST", path + "/events", message(attempted))).status, 409);
  assert.equal((await f.request("POST", path + "/events", message(crypto.randomUUID()))).status, 200);
  assert.equal(conversation.turns.filter((turn) => turn.officialCodeEventId === attempted).length, 1);
});

test("a first worktree send checks the approved origin after checkout is assigned", async () => {
  const f = fixture();
  f.host.settings().remoteControlSpawnMode = "worktree";
  const { value: { session } } = await f.create();
  const conversation = f.host.conversations()[0];
  assert.deepEqual(conversation.remoteCodeWorktree, { origin: folder });
  f.host.send = async (_input, _uuid, current) => {
    assert.equal(current(), true);
    conversation.worktree = { origin: folder, path: "/tree", repository: "/repo", branch: "test", name: "test" };
    conversation.cwd = "/tree";
    assert.equal(current(), true);
    f.host.settings().remoteFolders = [];
    assert.equal(current(), false);
  };
  const uuid = crypto.randomUUID();
  const result = await f.request("POST", `/v1/code/sessions/${session.id}/events`, {
    events: [{ payload: { type: "user", uuid, session_id: session.id, parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "hello" }] } } }],
  });
  assert.equal(result.status, 409);
});
