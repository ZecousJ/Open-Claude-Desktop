import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CloudEnvironments } from "../../electron/cloud/environments";
import type { Engine } from "../../electron/engine/engine";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { connectorUuid } from "../../electron/official-ui/api/connectors";
import { openPolicy } from "../../shared/client-policy";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH, hiwonderKnowledgeRelayUrl } from "../../shared/knowledge-api";
import {
  isOfficialUiAction,
  isOfficialUiQuery,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { AppEvent } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import { gitHubFetcher, runGit } from "../../runner/src/github-workspace";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { readOfficialCapabilities } from "../../src-web/official/negotiated-action";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

async function verifyCloudOutcome(
  t: TestContext,
  scenario: {
    outcome: string;
    source?: string;
    defaultSource?: boolean;
    reuse?: boolean;
    knowledge?: boolean;
    sideSession?: { requestId: string; parentId: string; taskId: string };
  },
) {
  useElectronShim();
  const [
    { Engine },
    { registerConversationTurnHandlers },
    { CloudStore },
    { run, newSession, resumedSetup },
    { stageCodeSession },
  ] = await Promise.all([
    import("../../electron/engine/engine"),
    import("../../electron/ipc/conversation-turn-handlers"),
    import("../../runner/src/cloud-store"),
    import("../../runner/src/dispatcher-sessions"),
    import("../../runner/src/web-context-code-sessions"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-create-"));
  const user = { id: 1, accessToken: "fixture" };
  const account = { id: "fixture-owner" };
  const organization = organizationUuid(account.id);
  const service = "https://knowledge.example.test";
  const web = memoryWebstore();
  const repo = path.join(root, "repo");
  const url = "https://github.com/fixture/repository";
  const branch = scenario.source ?? "feature/release!";
  const revision = scenario.defaultSource ? undefined : "refs/heads/" + branch;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(repo, "branch.txt"), "default branch");
  git(repo, "add", "branch.txt");
  git(repo, "commit", "--quiet", "-m", "Default branch");
  git(repo, "switch", "--quiet", "-c", branch);
  fs.writeFileSync(path.join(repo, "branch.txt"), "selected branch");
  git(repo, "commit", "--quiet", "-am", "Selected branch");
  git(repo, "switch", "--quiet", "main");

  const cloneRequests: unknown[] = [];
  const transport = {
    async request(op: string, userId: number, body?: { ref?: string }) {
      if (op !== "github.clone") return web.request(op, userId, body);
      assert.equal(userId, user.id);
      cloneRequests.push(body);
      return {
        url: `${url}.git`,
        username: "fixture",
        token: "fixture",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ref: body?.ref,
        defaultBranch: "main",
        repository: "fixture/repository",
      };
    },
  };
  const fetchInto = gitHubFetcher({
    transport,
    runGit: (run) =>
      runGit({
        ...run,
        argv: run.argv.map((arg) => (arg === `${url}.git` ? repo : arg)),
      }),
  });
  const profileRoot = path.join(root, "profile");
  const open = () =>
    CloudStore.open({ root: profileRoot, userId: user.id, transport });
  const listeners = new Set<(event: AppEvent) => void>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    userId: user.id,
    activeAccount: account,
    accountActivationIdentity: {},
    accountRetiring: false,
    ...(scenario.knowledge ? { remote: { ready: true, modelCatalog: () => null, backend: {
      accounts: { baseUrl: service }, session: { authorized: async () => ({
        bases: [{ id: HUANER_TECH, name: "Hiwonder Knowledge", available: true }],
      }) },
    } } } : {}),
    signedOut: false,
    closedFlag: false,
    store: await open(),
    engine: undefined as Engine | undefined,
    runtime: { transport },
    handlers,
    engineRunning: () => true,
    selectedAttachments: new Map(),
    officialSessionIdentity() {
      return this.accountActivationIdentity;
    },
    setAccessToken() {},
    allowedFolder() {},
    policy: () => openPolicy,
    push(event: AppEvent) {
      for (const listener of listeners) listener(event);
    },
    onEvent(listener: (event: AppEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAccountDeactivating: () => () => {},
    spaceRoot: (id: string) => path.join(profileRoot, "spaces", id),
    stageCodeSession,
    refetchCodeSession:
      (cwd: string, repositories: Parameters<typeof fetchInto>[1]) =>
      (signal?: AbortSignal) =>
        fetchInto(user.id, repositories, cwd, signal),
    log() {},
  };
  t.after(async () => {
    await ctx.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const provider = {
    id: "runner",
    name: "Runner",
    protocol: "responses" as const,
    baseUrl: "http://127.0.0.1:1/v1",
    model: "code-model",
    models: ["code-model"],
  };
  ctx.store.settings.providers = [provider];
  ctx.store.settings.activeProviderId = provider.id;
  ctx.store.settings.mcpServers = {
    wiki: { url: "https://wiki.example.test/mcp" },
    search: { url: "https://search.example.test/mcp" },
  };
  const profile = new CloudEnvironments(profileRoot).save({
    name: "Selected environment",
    network: "trusted",
    allowedDomains: [],
    includeDefaultDomains: true,
    variables: "",
    setupScript: "echo selected profile",
  });
  const dispatcher = {
    options: { officialUiRoot: root, officialUiActions: true, link: transport },
    guard: { modes: ["chat", "code"] },
    methods: ["send"],
    contextFor: async () => ctx as unknown as WebAppContext,
    context: () => ctx,
    now: Date.now,
    run,
    newSession,
    resumedSetup,
  } as unknown as Dispatcher;
  const call = (
    method: "officialUiRead" | "officialUiAction",
    request: OfficialUiReadRequest,
  ) =>
    dispatcher.run({
      t: "call",
      id: randomUUID(),
      user,
      method,
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request);
  const action = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request);
  let { activationLease } = await readOfficialCapabilities(
    read,
    String(user.id),
  );
  const route = "/v1/code/sessions";
  const expectedOverrides = scenario.knowledge ? { [HIWONDER_KNOWLEDGE_SERVER]: true } : { search: false };
  assert.equal(isOfficialUiAction("POST", route), true);
  assert.equal(isOfficialUiQuery("POST", route), false);
  assert.equal(isOfficialUiQuery("GET", route), true);
  const body = {
    environment_id: profile.id,
    config: {
      sources: [{ type: "git_repository", url, revision }],
      outcomes: [
        {
          type: "git_repository",
          git_info: {
            type: "github",
            repo: "fixture/repository",
            branches: [scenario.outcome],
          },
        },
      ],
      ...(scenario.reuse && { reuse_outcome_branches: true }),
      model: "code-model",
      effort_level: "high",
      permission_mode: "plan",
      append_system_prompt: "Use full PR URLs.",
      mcp_servers: [scenario.knowledge ? {
        name: connectorUuid(HIWONDER_KNOWLEDGE_SERVER),
        type: "http",
        url: hiwonderKnowledgeRelayUrl(service),
        headers: { "X-MCP-Server-ID": connectorUuid(HIWONDER_KNOWLEDGE_SERVER) },
      } : {
        name: "wiki",
        type: "http",
        url: "https://wiki.example.test/mcp",
        headers: { "X-MCP-Server-ID": connectorUuid("wiki") },
      }],
    },
    events: [],
    ...(scenario.sideSession ? { side_session: {
      request_id: scenario.sideSession.requestId,
      parent_session_id: scenario.sideSession.parentId,
      task_id: scenario.sideSession.taskId,
    } } : {}),
  };
  const post = (path: string, payload: unknown) => ({
    method: "POST" as const,
    path,
    capabilityLease: activationLease,
    codeOrganizationId: organization,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(payload)),
  });
  const create = post(route, body);
  await assert.rejects(read(create), /Invalid official Web request/);
  assert.equal(
    (await action({ ...create, capabilityLease: undefined })).status,
    409,
  );
  assert.equal(
    (await action({ ...create, codeOrganizationId: organizationUuid("other") }))
      .status,
    404,
  );
  assert.equal(
    (await action(post(route, { ...body, environment_id: randomUUID() })))
      .status,
    404,
  );
  assert.equal(
    (
      await action(
        post(route, { ...body, events: [{ payload: { type: "user" } }] }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await action(
        post(route, {
          ...body,
          title: "__warming__",
          tags: ["cowork-warm-start"],
        }),
      )
    ).status,
    501,
  );
  assert.equal(ctx.store.conversations.length, 0);
  const [outcome] = body.config.outcomes;
  for (const outcomes of [
    [outcome, outcome],
    [{ ...outcome, git_info: { ...outcome.git_info, repo: "other/repository" } }],
    [{ ...outcome, git_info: { ...outcome.git_info, branches: ["name with spaces"] } }],
  ]) {
    assert.equal((await action(post(route, { ...body, config: { ...body.config, outcomes } }))).status, 400);
    assert.equal(ctx.store.conversations.length, 0);
  }
  const [selected] = body.config.mcp_servers;
  for (const mcp_servers of [
    [selected, selected],
    [{ ...selected, url: "https://forged.example.test/mcp" }],
    [{ ...selected, headers: { "X-MCP-Server-ID": connectorUuid("another-account") } }],
  ]) {
    const answer = await action(post(route, { ...body, config: { ...body.config, mcp_servers } }));
    assert.equal(answer.status, 409);
    assert.equal(ctx.store.conversations.length, 0);
  }

  const reply = await action(create);
  assert.equal(reply.status, 200, Buffer.from(reply.body).toString());
  const { session } = JSON.parse(Buffer.from(reply.body).toString());
  if (scenario.sideSession) {
    assert.equal((await action(post(route, { ...body, title: "Different offer" }))).status, 409);
    assert.equal(ctx.store.conversations.length, 1);
  }
  assert.match(session.id, /^session_[a-f0-9]{32}$/);
  assert.equal(session.environment_id, profile.id);
  assert.equal(session.environment_kind, "anthropic_cloud");
  assert.deepEqual(session.config, {
    model: "code-model",
    effort_level: "high",
    permission_mode: "plan",
    sources: JSON.parse(JSON.stringify(body.config.sources)),
    outcomes: body.config.outcomes,
  });
  assert.equal(session.external_metadata, undefined);
  assert.deepEqual(cloneRequests, []);
  assert.deepEqual(ctx.store.conversations[0].turns, []);
  assert.deepEqual(ctx.store.conversations[0].connectorOverrides, expectedOverrides);
  const environment = ctx.store.conversations[0].environment;
  assert.ok(environment?.kind === "space");
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(ctx.spaceRoot(environment.spaceId), "cloud-environment.json"),
        "utf8",
      ),
    ),
    profile,
  );

  await ctx.store.close();
  ctx.store = await open();
  ctx.accountActivationIdentity = {};
  ({ activationLease } = await readOfficialCapabilities(read, String(user.id)));
  if (scenario.sideSession) {
    const retried = await action(post(route, body));
    assert.equal(retried.status, 200);
    assert.equal(JSON.parse(Buffer.from(retried.body).toString()).session.id, session.id);
    assert.equal(ctx.store.conversations.length, 1);
    assert.equal(ctx.store.conversations[0].cloudSideSessionSource?.parentId, scenario.sideSession.parentId);
  }
  const [conversation] = ctx.store.conversations;
  assert.ok(conversation.cwd);
  assert.equal(conversation.sessionAuthors?.ownerAccountUuid, account.id);
  assert.deepEqual(conversation.connectorOverrides, expectedOverrides);
  assert.equal(
    conversation.sessionInstructions,
    body.config.append_system_prompt,
  );
  const rpcMethods: string[] = [];
  const engine = new Engine(
    ctx.store,
    "unused",
    () => "",
    (event) => ctx.push(event),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { environment },
  );
  ctx.engine = engine;
  engine.ensure = async () => {};
  engine.policy = () => openPolicy;
  engine.rpc = {
    async call(method: string, args: { command?: string[] } = {}) {
      rpcMethods.push(method);
      if (method === "command/exec") {
        assert.deepEqual(args.command, [
          "/bin/bash",
          "-c",
          profile.setupScript,
        ]);
        return { exitCode: 0 };
      }
      if (method === "thread/start")
        return { thread: { id: "fixture-thread" } };
      if (method === "turn/start") {
        assert.equal(
          git(conversation.cwd!, "branch", "--show-current"),
          scenario.outcome,
        );
        assert.equal(
          fs.readFileSync(path.join(conversation.cwd!, "branch.txt"), "utf8"),
          scenario.defaultSource ? "default branch" : "selected branch",
        );
        assert.equal(
          git(conversation.cwd!, "for-each-ref", "--format=%(upstream:short)", `refs/heads/${scenario.outcome}`),
          scenario.reuse ? `origin/${branch}` : "",
        );
        assert.equal(
          git(conversation.cwd!, "rev-parse", "HEAD"),
          git(conversation.cwd!, "rev-parse", `refs/remotes/origin/${scenario.defaultSource ? "main" : branch}`),
        );
        return { turn: { id: "first-turn" } };
      }
      return {};
    },
  } as typeof engine.rpc;
  registerConversationTurnHandlers({
    context: ctx,
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  } as never);

  const firstMessage = {
    type: "user",
    uuid: scenario.sideSession?.requestId ?? randomUUID(),
    session_id: session.id,
    parent_tool_use_id: null,
    message: { role: "user", content: "Inspect this branch" },
  };
  const permission = {
    type: "control_request",
    request_id: "set-perm-mode-fixture",
    request: { subtype: "set_permission_mode", mode: "plan" },
  };
  const firstEvent = post(`/v1/sessions/${session.id}/events`, {
    events: [permission, firstMessage],
  });
  const sent = await action(firstEvent);
  assert.equal(sent.status, 200, Buffer.from(sent.body).toString());
  const repeated = await action(
    post(`${route}/${session.id.replace("session_", "cse_")}/events`, {
      events: [
        { payload: { ...permission, uuid: randomUUID() } },
        { payload: firstMessage },
      ],
    }),
  );
  assert.equal(repeated.status, 200, Buffer.from(repeated.body).toString());
  assert.deepEqual(repeated.body, sent.body);
  assert.deepEqual(cloneRequests, [{ url, ...(revision && { ref: revision }) }]);
  assert.ok(
    rpcMethods.indexOf("command/exec") < rpcMethods.indexOf("turn/start"),
  );
  assert.equal(
    rpcMethods.filter((method) => method === "turn/start").length,
    1,
  );
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].officialCodeEventId, firstMessage.uuid);
  assert.equal(conversation.turns[0].prompt, firstMessage.message.content);
  if (scenario.sideSession) {
    const receipt = await read({
      method: "GET", path: `${route}/${session.id}/events/${firstMessage.uuid}/receipt`,
    });
    assert.equal(receipt.status, 204);
  }
}

for (const [name, scenario] of [
  ["default", { outcome: "claude/generated-output" }],
  ["custom", { outcome: "Team_42/generated-output", source: "Team_42" }],
  ["reset with a default source", { outcome: "claude/fresh-output", defaultSource: true }],
  ["reuse", { outcome: "feature/release!", reuse: true }],
] as const) {
  test(`Cloud Code checks out the ${name} outcome on the first event`, (t) =>
    verifyCloudOutcome(t, scenario));
}

test("Cloud Code keeps ordinary connector defaults when starting with Hiwonder knowledge", (t) =>
  verifyCloudOutcome(t, { outcome: "claude/knowledge", knowledge: true }));

test("a Code side-session start and its first message reuse the confirmed child across Runner reopen", (t) =>
  verifyCloudOutcome(t, {
    outcome: "claude/side-task",
    defaultSource: true,
    sideSession: { requestId: randomUUID(), parentId: randomUUID(), taskId: "task_12345678" },
  }));
