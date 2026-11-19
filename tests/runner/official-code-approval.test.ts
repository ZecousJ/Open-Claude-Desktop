import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import TOML from "@iarna/toml";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { resolveRuntime } from "../../electron/engine/runtime";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import { openPolicy } from "../../shared/client-policy";
import {
  officialCodeApprovalControl,
  type OfficialCodeApprovalControl,
} from "../../shared/official-code-approval";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import type { AppEvent, Conversation } from "../../shared/types";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import {
  CodexHost,
  MODEL,
  MockResponses,
  tempRoot,
  toolPlan,
} from "../spikes/harness";
import { McpHttpServer } from "../spikes/mcp-http-server";
import { useElectronShim } from "./runner-core-support.test";

const binary = (() => {
  try {
    return resolveRuntime();
  } catch {
    return undefined;
  }
})();

for (const mode of ["code", "cowork"] as const) test(
  `Web ${mode} reconnects to live connector approvals`,
  {
    skip: !binary && "the bundled Codex binary is not installed",
    timeout: 60_000,
  },
  async (t) => {
    const platform = process.platform;
    useElectronShim();
    Object.defineProperty(process, "platform", { value: platform });
    const [{ Engine }, { EngineRegistry }, { Store }, { officialUiRead }] =
      await Promise.all([
        import("../../electron/engine/engine"),
        import("../../electron/engine/engine-registry"),
        import("../../electron/store/store"),
        import("../../runner/src/official-ui-read"),
      ]);
    const root = tempRoot(`official-${mode}-approval`);
    const model = await new MockResponses().start();
    const mcp = await new McpHttpServer("fixture").start();
    const home = path.join(root, "codex");
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, "config.toml"),
      TOML.stringify({
        mcp_servers: {
          probe: { url: mcp.url, bearer_token_env_var: "PROBE_TOKEN" },
        },
      }),
    );
    const host = await new CodexHost(
      home,
      model,
      {},
      { PROBE_TOKEN: "fixture" },
    ).start();
    const listeners = new Set<(event: AppEvent) => void>();
    const readerCancels = new Set<() => Promise<void>>();
    const threadId = await host.thread(MODEL, path.join(root, "workspace"));
    const account = { id: "fixture-owner" };
    const organization = organizationUuid(account.id);
    const user = { id: 1, accessToken: "fixture" };
    const store = new Store(path.join(root, "profile"));
    const conversation: Conversation = {
      id: `${mode}-fixture`,
      threadId,
      title: `${mode} fixture`,
      mode,
      environment: { kind: "space", spaceId: "fixture-space" },
      cwd: path.join(root, "workspace"),
      model: MODEL,
      providerId: "fixture",
      archived: false,
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    const other = { ...conversation, id: "another-session", turns: [] };
    store.conversations = [conversation, other];
    const engine = new Engine(
      store,
      binary!,
      () => "",
      (event) => {
        for (const listener of listeners) listener(event);
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { environment: conversation.environment },
    );
    t.after(async () => {
      await Promise.all([...readerCancels].map((cancel) => cancel()));
      await engine.stop();
      await host.stop();
      await mcp.close();
      await model.close();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    });
    engine.policy = () => openPolicy;
    engine.routes.set(threadId, conversation.id);
    engine.rpc = host.rpc;
    const engines = new EngineRegistry(() => engine);
    host.rpc.removeAllListeners("request");
    host.rpc.on("request", (request) => engine.request(request));
    host.rpc.on("notification", (message) => engine.notification(message));
    const onEvent = (listener: (event: AppEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    let identity = {};
    const ctx = {
      userId: user.id,
      activeAccount: account,
      store,
      engine,
      engines: {
        running: (id: string) =>
          store.conversations.some((row) => row.id === id) ? engine : undefined,
      },
      engineFor: (id: string) => engines.forConversation(id),
      services: {},
      appVersion: "fixture",
      officialSessionIdentity: () => identity,
      onEvent,
      setAccessToken() {},
      log() {},
    };
    const dispatcher = {
      options: { officialUiRoot: "/fixture", officialUiActions: true },
      guard: { modes: ["chat", "code", mode] },
      contextFor: async () => ctx,
      context: () => ctx,
      now: Date.now,
      async run(frame: CallFrame) {
        if (frame.method === "snapshot")
          return { conversations: store.conversations };
        if (frame.method === "conversationTurns") {
          const [id] = decodeWireValue(frame.args) as [string];
          return { turns: store.conversation(id).turns };
        }
        assert.fail(`Unexpected internal method ${frame.method}`);
      },
    } as unknown as Dispatcher;
    const call = (method: string) => (request: OfficialUiReadRequest) =>
      officialUiRead(dispatcher, {
        method,
        args: encodeWireValue([request]),
        user,
      } as CallFrame);
    const read = call("officialUiRead");
    const fetch = createOfficialReadFetch(
      "https://fixture.invalid",
      read,
      async () => assert.fail("Code approval escaped the Web bridge"),
      onEvent,
      negotiatedOfficialAction({
        mode: "engine-chat",
        accountId: String(user.id),
        isCurrent: () => true,
        read,
        action: call("officialUiAction"),
      }),
    );
    const prefix = mode === "cowork" ? "cse" : "session";
    const events = `/v1/code/sessions/${prefix}_${cloudCodeSessionKey(conversation, account.id)}/events`;
    const headers = { "x-organization-uuid": organization };
    async function connect(lastId = "0") {
      const answer = await fetch(events + "/stream", {
        headers: mode === "cowork" ? headers : { ...headers, "last-event-id": lastId },
      });
      assert.equal(answer.status, 200);
      const reader = answer.body!.getReader();
      const cancel = () => reader.cancel();
      readerCancels.add(cancel);
      let buffered = "";
      let pending: OfficialCodeApprovalControl[] = [];
      const seen = new Set<string>();
      return {
        async control(
          type: "control_request" | "control_cancel_request",
          requestId?: string,
        ) {
          while (true) {
            if (mode === "cowork" && type === "control_request" && pending.length)
              return pending.shift();
            const frameEnd = buffered.indexOf("\n\n");
            if (frameEnd < 0) {
              const next = await reader.read();
              assert.ok(!next.done && next.value);
              buffered += new TextDecoder().decode(next.value);
              continue;
            }
            const frame = buffered.slice(0, frameEnd);
            buffered = buffered.slice(frameEnd + 2);
            const data = frame.match(/^data: (.*)$/m);
            if (!data) continue;
            const { source, payload, sequence_num } = JSON.parse(data[1]);
            if (mode === "cowork" && payload?.type === "claudex_cowork_approvals") {
              assert.match(frame, /^event: client_event\n/);
              assert.equal(source, "worker");
              assert.equal(sequence_num, undefined);
              assert.doesNotMatch(frame, /^id: /m);
              const controls = officialCodeApprovalControl.array().parse(payload.controls);
              pending = controls.filter((control) => !seen.has(control.request_id));
              for (const control of controls) seen.add(control.request_id);
              if (type === "control_cancel_request" &&
                  !controls.some((approval) => approval.request_id === requestId)) return;
              continue;
            }
            if (
              payload?.type !== type ||
              (requestId && payload.request_id !== requestId)
            )
              continue;
            assert.match(frame, /^event: client_event\n/);
            assert.equal(source, "worker");
            return payload;
          }
        },
        cancel,
      };
    }
    const postBatch = (
      decisions: [OfficialCodeApprovalControl, unknown][],
      url = events,
      org = organization,
    ) =>
      fetch(url, {
        method: "POST",
        headers: { "x-organization-uuid": org, "content-type": "application/json" },
        body: JSON.stringify({
          events: decisions.map(([control, response]) => ({
              payload: {
                type: "control_response",
                uuid: randomUUID(),
                response: {
                  subtype: "success",
                  request_id: control.request_id,
                  response,
                },
              },
            })),
        }),
      });
    const post = (control: OfficialCodeApprovalControl, response: unknown, url = events, org = organization) =>
      postBatch([[control, response]], url, org);
    function run(
      tool: "echo" | "ask",
      args: Record<string, unknown>,
      prompt: string,
    ) {
      conversation.turns.push({
        id: "pending-fixture",
        prompt,
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: Date.now(),
      });
      model.script = toolPlan([{ suffix: "probe_" + tool, args }]);
      return host.turn(threadId, prompt);
    }
    const initial = await connect();
    const allowedTurn = run(
      "echo",
      { text: "approve only this" },
      "Approve one echo",
    );
    const approval = officialCodeApprovalControl.parse(
      await initial.control("control_request"),
    );
    assert.equal(approval.request.subtype, "can_use_tool");
    if (approval.request.subtype !== "can_use_tool") assert.fail();
    const toolUseID = approval.request.tool_use_id;
    assert.match(toolUseID, new RegExp(`^${conversation.turns[0].id}:tool:`));
    assert.deepEqual(approval.request.input, { text: "approve only this" });
    await initial.cancel();
    const prior = await (
      await fetch(events + "?limit=100", { headers })
    ).json();
    let reopened = await connect(prior.resume_cursor);
    assert.deepEqual(await reopened.control("control_request"), approval);
    const allow = {
      behavior: "allow",
      toolUseID,
      updatedInput: approval.request.input,
    };
    assert.equal(
      (
        await post(approval, {
          ...allow,
          updatedInput: { text: "substituted" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await post(approval, { ...allow, updatedPermissions: [] })).status,
      400,
    );
    assert.equal(
      (await post(approval, { ...allow, toolUseID: "other-tool" })).status,
      400,
    );
    assert.equal(
      (
        await post(
          approval,
          allow,
          `/v1/code/sessions/session_${cloudCodeSessionKey(other, account.id)}/events`,
        )
      ).status,
      409,
    );
    assert.equal(
      mcp.log.filter(({ method }) => method === "tools/call").length,
      0,
    );
    if (mode === "cowork") {
      assert.equal((await post(approval, allow, events, randomUUID())).status, 404);
      identity = {};
      assert.equal((await post(approval, allow)).status, 409);
      await reopened.cancel();
      reopened = await connect();
      const refreshed = officialCodeApprovalControl.parse(await reopened.control("control_request"));
      assert.notEqual(refreshed.request_id, approval.request_id);
      assert.deepEqual(refreshed.request, approval.request);
      assert.equal((await post(refreshed, allow)).status, 200);
      await reopened.control("control_cancel_request", refreshed.request_id);
      assert.equal((await post(refreshed, allow)).status, 409);
    } else {
      assert.equal((await post(approval, allow)).status, 200);
      await reopened.control("control_cancel_request", approval.request_id);
    }
    await allowedTurn;
    assert.equal(
      mcp.log.filter(({ method }) => method === "tools/call").length,
      1,
    );
    assert.equal((await post(approval, allow)).status, 409);

    const deniedTurn = run("echo", { text: "do not run" }, "Deny this echo");
    const denied = officialCodeApprovalControl.parse(
      await reopened.control("control_request"),
    );
    if (denied.request.subtype !== "can_use_tool") assert.fail();
    await reopened.cancel();
    assert.equal(
      (
        await post(denied, {
          behavior: "deny",
          toolUseID: denied.request.tool_use_id,
          message: "Denied by user",
        })
      ).status,
      200,
    );
    await deniedTurn;
    const afterDeny = await (
      await fetch(events + "?limit=100", { headers })
    ).json();
    reopened = await connect(afterDeny.resume_cursor);
    await reopened.control("control_cancel_request", denied.request_id);
    assert.equal(
      mcp.log.filter(({ method }) => method === "tools/call").length,
      1,
    );

    if (mode === "code") {
      const formTurn = run("ask", {}, "Answer the connector form");
      const callApproval = officialCodeApprovalControl.parse(
        await reopened.control("control_request"),
      );
      if (callApproval.request.subtype !== "can_use_tool") assert.fail();
      assert.equal(
        (
          await post(callApproval, {
            behavior: "allow",
            toolUseID: callApproval.request.tool_use_id,
            updatedInput: {},
          })
        ).status,
        200,
      );
      const form = officialCodeApprovalControl.parse(
        await reopened.control("control_request"),
      );
      assert.equal(form.request.subtype, "elicitation");
      if (form.request.subtype !== "elicitation" || form.request.mode !== "form")
        assert.fail();
      assert.deepEqual(form.request.property_order, ["choice"]);
      assert.equal((await post(form, { action: "accept" })).status, 400);
      assert.equal(
        (await post(form, { action: "accept", content: { choice: "unlisted" } }))
          .status,
        400,
      );
      assert.equal(
        (
          await post(form, {
            action: "accept",
            content: { choice: "allow_once" },
          })
        ).status,
        200,
      );
      await formTurn;
      assert.deepEqual(mcp.elicitationAnswers, [
        { action: "accept", content: { choice: "allow_once" } },
      ]);
    }
    mcp.elicitation = {
      mode: "url",
      url: "https://example.com/connect",
      elicitationId: "connector-link",
      message: "Connect the fixture account",
    };
    const urlTurn = run("ask", {}, "Answer the connector link");
    const urlTool = officialCodeApprovalControl.parse(
      await reopened.control("control_request"),
    );
    if (urlTool.request.subtype !== "can_use_tool") assert.fail();
    assert.equal(
      (
        await post(urlTool, {
          behavior: "allow",
          toolUseID: urlTool.request.tool_use_id,
          updatedInput: {},
        })
      ).status,
      200,
    );
    const link = officialCodeApprovalControl.parse(
      await reopened.control("control_request"),
    );
    assert.deepEqual(link.request, {
      subtype: "elicitation",
      mcp_server_name: "probe",
      mode: "url",
      url: "https://example.com/connect",
      elicitation_id: "connector-link",
      message: "Connect the fixture account",
    });
    assert.equal(
      (await post(link, { action: "accept", content: {} })).status,
      400,
    );
    assert.equal((await post(link, { action: "accept" })).status, 200);
    await urlTurn;
    assert.deepEqual(mcp.elicitationAnswers.at(-1), {
      action: "accept",
      content: {},
    });
    assert.doesNotMatch(
      fs.readFileSync(path.join(home, "config.toml"), "utf8"),
      /approval_mode/,
    );

    if (mode === "cowork") {
      const batchTurn = run("echo", { text: "allowed batch call" }, "Review two Cowork approvals");
      const tool = officialCodeApprovalControl.parse(await reopened.control("control_request"));
      if (tool.request.subtype !== "can_use_tool") assert.fail();
      const turnId = conversation.turns.at(-1)?.id;
      assert.ok(turnId);
      const connection = engine.requestAppApproval(conversation.id, {
        threadId, turnId, serverName: "probe", mode: "url", url: "https://example.com/connect",
        message: "Connect a second account",
      });
      const link = officialCodeApprovalControl.parse(await reopened.control("control_request"));
      assert.equal(link.request.subtype, "elicitation");
      const allow = { behavior: "allow", toolUseID: tool.request.tool_use_id, updatedInput: tool.request.input };
      const decline = { action: "decline" };
      const calls = () => mcp.log.filter(({ method }) => method === "tools/call").length;
      const before = calls();
      assert.equal((await postBatch([[tool, allow], [link, { ...decline, content: {} }]])).status, 400);
      assert.equal(calls(), before);
      assert.equal((await postBatch([[tool, allow], [link, decline]])).status, 200);
      assert.deepEqual(await connection, { action: "decline", content: null, _meta: null });
      await batchTurn;
      assert.equal(calls(), before + 1);
      assert.equal((await postBatch([[tool, allow], [link, decline]])).status, 409);
    }

    const runCommand = (file: string) => {
      const target = path.join(conversation.cwd!, file);
      const command =
        process.platform === "win32"
          ? `Add-Content -LiteralPath '${target}' -Value F084_MARKER -NoNewline`
          : `printf F084_MARKER >> '${target}'`;
      const prompt = `Request approval for the ${file} fixture`;
      conversation.turns.push({
        id: "pending-fixture",
        prompt,
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: Date.now(),
      });
      model.script = toolPlan([
        {
          suffix: "exec_command",
          args: {
            cmd: command,
            workdir: conversation.cwd,
            sandbox_permissions: "require_escalated",
            justification: "Write the isolated approval marker.",
          },
        },
      ]);
      return { target, command, done: host.turn(threadId, prompt) };
    };
    const allowedCommand = runCommand("allow-f084.txt");
    const commandCard = officialCodeApprovalControl.parse(
      await reopened.control("control_request"),
    );
    if (mode === "code") assert.match(commandCard.request_id, /^code-command:/);
    assert.equal(commandCard.request.subtype, "can_use_tool");
    if (commandCard.request.subtype !== "can_use_tool") assert.fail();
    assert.equal(commandCard.request.tool_name, "Bash");
    assert.equal(commandCard.request.suppress_always_allow_rule, mode === "cowork");
    if (mode === "code")
      assert.deepEqual(commandCard.request.permission_suggestions, [{
        type: "addRules",
        behavior: "allow",
        destination: "session",
        rules: [{ toolName: "Bash", ruleContent: commandCard.request.input.command }],
      }]);
    assert.ok(
      String(commandCard.request.input.command).includes(
        allowedCommand.command,
      ),
    );
    assert.equal(fs.existsSync(allowedCommand.target), false);
    const allowCommand = {
      behavior: "allow",
      toolUseID: commandCard.request.tool_use_id,
      toolName: "Bash",
      updatedInput: commandCard.request.input,
    };
    if (mode === "cowork") {
      await reopened.cancel();
      reopened = await connect();
      assert.deepEqual(await reopened.control("control_request"), commandCard);
    }
    assert.equal(
      (await post(commandCard, { ...allowCommand, toolName: "Read" })).status,
      400,
    );
    assert.equal(
      (
        await post(commandCard, {
          ...allowCommand,
          updatedInput: { command: "printf changed" },
        })
      ).status,
      mode === "cowork" ? 400 : 409,
    );
    const otherEvents = `/v1/code/sessions/session_${cloudCodeSessionKey(other, account.id)}/events`;
    assert.equal(
      (await post(commandCard, allowCommand, otherEvents)).status,
      409,
    );
    assert.equal(fs.existsSync(allowedCommand.target), false);
    assert.equal((await post(commandCard, allowCommand)).status, 200);
    await reopened.control("control_cancel_request", commandCard.request_id);
    await allowedCommand.done;
    assert.equal(
      (await post(commandCard, allowCommand)).status,
      mode === "cowork" ? 409 : 200,
    );
    assert.equal(fs.readFileSync(allowedCommand.target, "utf8"), "F084_MARKER");
    assert.equal(
      (
        await post(commandCard, {
          behavior: "deny",
          toolUseID: commandCard.request.tool_use_id,
          message: "Undo",
        })
      ).status,
      409,
    );

    const deniedCommand = runCommand("deny-f084.txt");
    const denyCard = officialCodeApprovalControl.parse(
      await reopened.control("control_request"),
    );
    assert.equal(denyCard.request.subtype, "can_use_tool");
    if (denyCard.request.subtype !== "can_use_tool") assert.fail();
    assert.ok(
      String(denyCard.request.input.command).includes(deniedCommand.command),
    );
    const deny = {
      behavior: "deny",
      toolUseID: denyCard.request.tool_use_id,
      message: "Denied in the fixture",
    };
    if (mode === "cowork") {
      assert.equal((await post(denyCard, deny)).status, 200);
      await deniedCommand.done;
      assert.equal(fs.existsSync(deniedCommand.target), false);
      return;
    }
    const legacyEvents = `/v1/sessions/session_${cloudCodeSessionKey(conversation, account.id)}/events`;
    const denyResponse = await fetch(legacyEvents, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: denyCard.request_id,
              response: deny,
            },
          },
        ],
      }),
    });
    assert.equal(denyResponse.status, 200);
    await deniedCommand.done;
    assert.equal(fs.existsSync(deniedCommand.target), false);
  },
);
