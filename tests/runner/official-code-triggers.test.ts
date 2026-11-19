import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AppContext } from "../../electron/app/app-context";
import { registerScheduleHandlers } from "../../electron/ipc/collections-schedules";
import { connectorUuid } from "../../electron/official-ui/api/connectors";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { Scheduler } from "../../electron/routines/scheduler";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import {
  officialCodeTriggerId,
  routineIdFromOfficialCodeTrigger,
} from "../../shared/official-code-triggers";
import type { RoutineInput } from "../../shared/routines";
import type { Conversation, Settings } from "../../shared/types";

const base = "/v1/code/triggers";
const owner = { id: "owner", name: "Owner", email: "owner@example.invalid" };
const epoch = Date.parse("2026-11-13T12:00:00.000Z");
const draft = {
  name: "Build report",
  enabled: false,
  cron_expression: "0 9 * * *",
  persist_session: false,
  mcp_connections: [],
  clear_mcp_connections: true,
  job_config: {
    ccr: {
      environment_id: "default",
      session_context: {
        allowed_tools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
        ],
        sources: [],
        outcomes: [],
        model: "model-a",
      },
      events: [
        {
          data: {
            uuid: "7fbb4884-0831-4fea-a30b-8f4100a8a39b",
            session_id: "",
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content: "Summarize build failures." },
          },
        },
      ],
    },
  },
};

function fixture(t: TestContext, writable = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-trigger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const conversations: Conversation[] = [];
  const settings = {
    providers: [{ id: "provider", model: "model-a", models: ["model-b"] }],
    activeProviderId: "provider",
    mcpServers: {
      docs: {
        type: "http",
        display_name: "My Docs",
        url: "https://docs.example.invalid/mcp",
        headers: { Authorization: "fixture-secret" },
      },
      issues: { type: "http", url: "https://issues.example.invalid/mcp" },
      local: { command: "fixture-tool" },
    },
  } as unknown as Settings;
  let identity = 1;
  const started: { task: string; prompt: string }[] = [];
  const executionInputs: RoutineInput[] = [];
  const tokens = new Map<string, string>();
  const hooks = new Map<string, { repository: string; events: string[] }>();
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => epoch,
    run: async (task) => {
      started.push({ task: task.id, prompt: task.prompt });
      executionInputs.push(task);
      const conversation = {
        id: "run-" + started.length,
        mode: task.mode,
        scheduledTaskId: task.id,
        createdAt: epoch,
        threadId: "thread-" + started.length,
        turns: [
          {
            id: "turn-" + started.length,
            createdAt: epoch,
            status: "inProgress",
            prompt: task.prompt,
          },
        ],
      } as unknown as Conversation;
      conversations.push(conversation);
      return conversation;
    },
  });
  const ctx = {
    scheduler,
    routineSources: () => ["code"],
    store: {
      settings,
      root,
      projects: [],
      conversations,
      flush() {},
      conversation: (id: string) => conversations.find((row) => row.id === id),
    },
    allowedFolder(cwd?: string) {
      assert.equal(cwd, undefined);
    },
    engineFor: () => engine,
    services: {
      routineGitHubHook: async (
        id: string,
        action: string,
        input: { repository: string; events: string[] },
      ) => {
        if (action === "delete") hooks.delete(id);
        else hooks.set(id, input);
        return {};
      },
      routineApiToken: async (id: string, action: string) => {
        if (action === "delete") {
          tokens.delete(id);
          return {};
        }
        tokens.set(id, "fixture-token");
        return { token: "fixture-token", hint: "fixt" };
      },
    },
    push() {},
  } as unknown as AppContext;
  const engine = {
    async interrupt(id: string) {
      const conversation = conversations.find((row) => row.id === id);
      const turn = conversation?.turns.at(-1);
      assert.ok(conversation && turn);
      turn.status = "interrupted";
      scheduler.observeConversation(conversation);
    },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerScheduleHandlers({
    ctx,
    handle: (name, fn) => handlers.set(name, fn),
    setup: { available: () => false },
  });
  let retireOnList = false;
  const host = {
    account: () => owner,
    settings: () => settings,
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
    officialCodeRoutineFireUrl: (id: string) =>
      "https://service.example.invalid/api/v1/claudex/routines/" + id + "/fire",
  };
  const adapter = createRunnerOfficialAdapter(
    host,
    async (name, args) => {
      const handler = handlers.get(name);
      assert.ok(handler, "Unknown dispatch: " + name);
      const answer = await handler(...args);
      if (
        retireOnList &&
        (name === "listSchedules" || name === "officialCodeRoutineSnapshot")
      )
        identity++;
      return answer;
    },
    root,
    { modes: ["code", "cowork"] },
    { allowTextActions: writable },
  );
  const request = async (
    method: OfficialUiReadRequest["method"],
    route = base,
    value?: unknown,
    organization = organizationUuid(owner.id),
  ) => {
    const response = await adapter({
      method,
      path: route,
      codeOrganizationId: organization,
      ...(value !== undefined && {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(value)),
      }),
    });
    return {
      status: response.status,
      value: response.body.byteLength
        ? JSON.parse(Buffer.from(response.body).toString())
        : undefined,
    };
  };
  return {
    scheduler,
    root,
    request,
    started,
    executionInputs,
    tokens,
    hooks,
    removeConnector(key: string) {
      delete settings.mcpServers[key];
    },
    retireDuringRead() {
      retireOnList = true;
    },
  };
}

test("original Code form stores and rereads a UTC schedule, filters it and forks a paused copy", async (t) => {
  const { scheduler, root, request } = fixture(t);
  const created = await request("POST", base, draft);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const id = created.value.trigger.id;
  assert.match(id, /^trig_[a-f0-9-]{36}$/);
  assert.equal(created.value.trigger.cron_expression, "CRON_TZ=UTC 0 9 * * *");
  const saved = new Scheduler(root, {
    isBusy: () => true,
    run: async () => {
      throw Error("Unexpected execution");
    },
    now: () => epoch,
  }).list()[0];
  assert.equal(saved.nextRunAt, Date.parse("2026-11-14T09:00:00.000Z"));
  assert.equal(saved.prompt, "Summarize build failures.");
  const edited = await request("POST", base + "/" + id, {
    name: "Daily report",
    cron_expression: "CRON_TZ=Asia/Shanghai 0 9 * * *",
  });
  assert.equal(edited.status, 200);
  assert.equal(
    scheduler.list()[0].nextRunAt,
    Date.parse("2026-11-14T01:00:00.000Z"),
  );
  const copied = await request("POST", base + "/" + id + "/fork", {
    name: "Copy of Daily report",
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.value));
  assert.notEqual(copied.value.trigger.id, id);
  assert.equal(copied.value.trigger.enabled, false);
  assert.equal(copied.value.trigger.derived_state.prompt, saved.prompt);
  const page = await request(
    "GET",
    base + "?limit=1&exclude_tags=cowork-scheduled",
  );
  assert.equal(page.value.data.length, 1);
  assert.equal(page.value.has_more, true);
  const next = await request(
    "GET",
    base +
      "?limit=1&exclude_tags=cowork-scheduled&cursor=" +
      page.value.next_cursor,
  );
  assert.equal(next.value.data.length, 1);
  assert.notEqual(next.value.data[0].id, page.value.data[0].id);
  assert.equal(next.value.has_more, false);
  assert.equal((await request("DELETE", base + "/" + id, {})).status, 204);
  assert.equal((await request("GET", base + "/" + id)).status, 404);
});

test("the stock form saves repository order and account connectors for future runs", async (t) => {
  const { request, executionInputs, scheduler, removeConnector } = fixture(t);
  const urls = [
    "https://github.com/example/primary",
    "https://github.com/example/secondary",
  ];
  const sources = urls.map((url) => ({ git_repository: { url } }));
  const outcomes = ["secondary", "primary"].map((name) => ({
    git_repository: {
      git_info: {
        repo: `example/${name}`,
        branches: [`claude/result-${name}`],
      },
    },
  }));
  const connection = {
    connector_uuid: connectorUuid("docs"),
    name: "Browser label",
    url: "https://docs.example.invalid/mcp",
  };
  const input = {
    ...draft,
    clear_mcp_connections: false,
    mcp_connections: [connection],
    job_config: {
      ccr: {
        ...draft.job_config.ccr,
        session_context: {
          ...draft.job_config.ccr.session_context,
          sources,
          outcomes,
        },
      },
    },
  };
  const created = await request("POST", base, input);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const route = base + "/" + created.value.trigger.id;
  const edited = await request("POST", route, { model: "model-b" });
  assert.equal(edited.status, 200, JSON.stringify(edited.value));
  const detail = (await request("GET", route)).value.trigger;
  assert.equal(detail.job_config.ccr.session_context.model, "model-b");
  assert.deepEqual(detail.job_config.ccr.session_context.sources, sources);
  assert.deepEqual(detail.mcp_connections, [
    { ...connection, name: "My-Docs" },
  ]);
  assert.doesNotMatch(JSON.stringify(detail), /fixture-secret/);

  for (const invalid of [
    {
      ...input,
      mcp_connections: [
        { ...connection, url: "https://foreign.example.invalid/mcp" },
      ],
    },
    {
      ...input,
      mcp_connections: [
        { ...connection, connector_uuid: connectorUuid("local") },
      ],
    },
    {
      ...input,
      job_config: {
        ccr: {
          ...input.job_config.ccr,
          session_context: {
            ...input.job_config.ccr.session_context,
            outcomes: [
              {
                git_repository: {
                  git_info: {
                    repo: "foreign/repository",
                    branches: ["claude/test"],
                  },
                },
              },
            ],
          },
        },
      },
    },
  ]) {
    assert.equal((await request("POST", route, invalid)).status, 400);
  }

  const ran = await request("POST", route + "/run", {});
  assert.equal(ran.status, 200, JSON.stringify(ran.value));
  assert.equal(executionInputs[0].model, "model-b");
  assert.deepEqual(
    executionInputs[0].repositories,
    urls.map((url) => ({ url })),
  );
  assert.deepEqual(executionInputs[0].repository, { url: urls[0] });
  assert.deepEqual(executionInputs[0].codeConnectorSelections, [
    { key: "docs", url: connection.url },
  ]);
  removeConnector("docs");
  assert.deepEqual(
    (await request("GET", route)).value.trigger.mcp_connections,
    [{ ...connection, name: "docs" }],
  );
  const cleared = await request("POST", route, {
    mcp_connections: [],
    clear_mcp_connections: true,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.value));
  assert.deepEqual(cleared.value.trigger.mcp_connections, []);
  assert.deepEqual(scheduler.list()[0].codeConnectorSelections, []);
});

test("run, cancellation and API token stay bound to the saved task", async (t) => {
  const { request, started, tokens } = fixture(t);
  const created = await request("POST", base, draft);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const id = created.value.trigger.id;
  const run = await request("POST", base + "/" + id + "/run", {
    text: "Include regressions.",
  });
  assert.equal(run.status, 200, JSON.stringify(run.value));
  assert.deepEqual(started, [
    {
      task: routineIdFromOfficialCodeTrigger(id),
      prompt: "Summarize build failures.\n\nInclude regressions.",
    },
  ]);
  assert.match(run.value.session_id, /^session_[a-f0-9]{32}$/);
  assert.equal(run.value.trigger.last_run.session_id, run.value.session_id);
  assert.equal(
    (
      await request(
        "POST",
        base + "/" + id + "/runs/session_" + "0".repeat(32) + "/cancel",
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "POST",
        base + "/" + id + "/runs/" + run.value.session_id + "/cancel",
        {},
      )
    ).status,
    204,
  );
  assert.equal(
    (await request("GET", base + "/" + id)).value.trigger.last_run.status,
    "ROUTINE_RUN_STATUS_ABANDONED",
  );
  const token = await request("POST", base + "/" + id + "/api-token", {});
  assert.equal(token.status, 200, JSON.stringify(token.value));
  assert.equal(token.value.token, "fixture-token");
  const detail = (await request("GET", base + "/" + id)).value.trigger;
  assert.equal(detail.api_token_hint, "fixt");
  assert.equal(detail.api_fire_url, token.value.api_fire_url);
  assert.equal(tokens.get(detail.api_trigger_id), "fixture-token");
  assert.doesNotMatch(JSON.stringify(detail), /fixture-token/);
  assert.equal(
    (await request("DELETE", base + "/" + id + "/api-token", {})).status,
    204,
  );
  assert.equal(tokens.size, 0);
  assert.equal(
    (await request("GET", base + "/" + id)).value.trigger.api_token_hint,
    undefined,
  );
});

test("cloud trigger writes cannot reach Cowork, foreign accounts or a retired activation", async (t) => {
  const { scheduler, request, retireDuringRead } = fixture(t);
  const existing: RoutineInput = {
    mode: "cowork",
    executionLocation: "remote",
    enabled: false,
    name: "Cowork task",
    prompt: "Review docs.",
    nextRunAt: epoch,
    frequency: "daily",
    providerId: "provider",
    model: "model-a",
  };
  const cowork = scheduler.save(existing);
  assert.equal(
    (await request("GET", base + "?limit=100&tags=cowork-scheduled")).value
      .data[0].id,
    officialCodeTriggerId(cowork.id),
  );
  assert.deepEqual(
    (await request("GET", base + "?exclude_tags=cowork-scheduled")).value.data,
    [],
  );
  assert.equal(
    (
      await request("POST", base + "/" + officialCodeTriggerId(cowork.id), {
        name: "Renamed",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("POST", base, draft, organizationUuid("foreign"))).status,
    404,
  );
  assert.equal(
    (await request("POST", base, { ...draft, persist_session: true })).status,
    400,
  );
  assert.equal(
    (await request("POST", base, { ...draft, bound_device_uuid: "foreign" }))
      .status,
    400,
  );
  assert.equal(
    (await request("POST", base + "?route=wrong", draft)).status,
    501,
  );
  assert.equal((await request("GET", base + "?enabled=broken")).status, 400);
  retireDuringRead();
  assert.equal((await request("POST", base, draft)).status, 409);
  assert.deepEqual(
    scheduler.list().map((task) => task.name),
    ["Cowork task"],
  );
});

test("the original cloud picker gets its own active environments and never credentials", async (t) => {
  const { root, request } = fixture(t, false);
  fs.writeFileSync(
    path.join(root, "cloud-environments.json"),
    JSON.stringify([
      {
        id: "default",
        name: "Account default",
        updatedAt: epoch,
        variables: "PRIVATE=secret",
        setupScript: "private setup",
      },
    ]),
  );
  const org = organizationUuid(owner.id);
  const result = await request(
    "GET",
    "/v1/environment_providers/private/organizations/" +
      org +
      "/environments?limit=1000",
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.value.environments.map(
      ({ environment_id, state, kind, name }: Record<string, string>) => ({
        environment_id,
        state,
        kind,
        name,
      }),
    ),
    [
      {
        environment_id: "default",
        state: "active",
        kind: "anthropic_cloud",
        name: "Account default",
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(result.value),
    /PRIVATE=secret|private setup/,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/v1/environment_providers/private/organizations/" +
          organizationUuid("foreign") +
          "/environments?limit=1000",
      )
    ).status,
    404,
  );
});

test("the stock GitHub hook editor reads, replaces and deletes a real scheduler trigger", async (t) => {
  const { request, hooks, scheduler } = fixture(t);
  const route = "/v1/code/webhook-triggers";
  const { status, value } = await request("POST", base, {
    ...draft,
    job_config: {
      ccr: {
        ...draft.job_config.ccr,
        session_context: {
          ...draft.job_config.ccr.session_context,
          sources: [
            { git_repository: { url: "https://github.com/example/repo" } },
          ],
          outcomes: [
            {
              git_repository: {
                git_info: { repo: "example/repo", branches: ["claude/test"] },
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(status, 200, JSON.stringify(value));
  const selected = route + "?routine_trigger_id=" + value.trigger.id;
  assert.deepEqual((await request("GET", selected)).value, {
    data: [],
    has_more: false,
  });
  const hook = {
    source: "github",
    hook_type: "app",
    scope_id: "https://github.com/example/repo",
    routine_trigger_id: value.trigger.id,
    events: ["pull_request.closed"],
    filter: {
      clauses: [{ field: "pr.merged", op: "FILTER_OP_EQ", values: ["true"] }],
    },
  };
  const added = await request("POST", route, hook);
  assert.equal(added.status, 200, JSON.stringify(added.value));
  const initial = added.value.trigger.trigger_id;
  assert.deepEqual((await request("GET", selected)).value.data, [
    { ...hook, trigger_id: initial },
  ]);
  assert.deepEqual(hooks.get(initial), {
    repository: "example/repo",
    events: ["pull_request"],
  });
  const edited = await request("POST", route, {
    ...hook,
    events: ["pull_request.opened"],
    filter: undefined,
  });
  assert.equal(edited.status, 200);
  const next = edited.value.trigger.trigger_id;
  assert.notEqual(next, initial);
  assert.equal(
    (await request("DELETE", route + "/" + initial, {})).status,
    204,
  );
  assert.equal((await request("GET", selected)).value.data[0].trigger_id, next);
  assert.equal(hooks.has(initial), false);
  assert.equal(hooks.has(next), true);
  assert.equal((await request("DELETE", route + "/" + next, {})).status, 204);
  assert.equal(scheduler.list()[0].triggers?.github, undefined);
  assert.equal(hooks.size, 0);
});
