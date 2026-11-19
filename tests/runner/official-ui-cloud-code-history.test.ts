import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "../../electron/engine/engine";
import { defaultSettings, Store } from "../../electron/store/store";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  isOfficialUiQuery,
  isOfficialUiAction,
  officialUiReadMaxBytes,
} from "../../shared/official-ui-web";
import type { AppEvent, Conversation, Turn } from "../../shared/types";

test("Cloud Code offers the latest suggestion after its result and preserves the transcript cursor", { timeout: 5_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-cloud-suggestion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = { id: "fixture-owner", name: "Owner", email: "owner@example.invalid" };
  const turn: Turn = {
    id: "first",
    prompt: "Review the tests",
    createdAt: 1,
    attachments: [],
    status: "inProgress",
    items: Array.from({ length: 101 }, (_, index) => ({
      id: `reply-${index}`,
      type: "agentMessage",
      text: `Review note ${index}`,
      status: "completed",
    })),
  };
  const conversation: Conversation = {
    id: "suggestions", mode: "code", title: "Review", providerId: "runner", model: "code-model",
    createdAt: 1, updatedAt: 1, pinned: false, archived: false, turns: [turn],
  };
  const settings = { ...defaultSettings, ccPromptSuggestions: true };
  const bridge = createRunnerOfficialAdapter({
    account: () => owner,
    settings: () => settings,
    sessionIdentity: () => owner,
    stateDirectory: () => root,
    log() {},
  } as never, async (method) => {
    if (method === "snapshot") return { conversations: [conversation] };
    if (method === "conversationTurns") return { turns: conversation.turns };
    assert.fail(`Unexpected runner dispatch ${method}`);
  }, root, { modes: ["code"] });
  const listeners = new Set<(event: AppEvent) => void>();
  let batchRead: (() => void) | undefined;
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    async (request) => {
      const response = await bridge(request);
      if (request.path.includes("/events/stream?")) batchRead?.();
      return response;
    },
    async () => assert.fail("Code suggestion request escaped the Web bridge"),
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  );
  const notify = (event: AppEvent = { type: "conversation", conversation }) =>
    listeners.forEach((listener) => listener(event));
  const headers = { "x-organization-uuid": organizationUuid(owner.id) };
  const sessions = await (await fetch("/v1/code/sessions", { headers })).json();
  const events = `/v1/code/sessions/${sessions.data[0].id}/events`;
  const history = async () => (await fetch(`${events}?sort_order=asc&limit=500`, { headers })).json();
  const open = async (cursor: string) => {
    const response = await fetch(`${events}/stream`, { headers: { ...headers, "Last-Event-ID": cursor } });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    return {
      next: async () => new TextDecoder().decode((await reader.read()).value),
      close: () => reader.cancel(),
    };
  };
  const reader = await open((await history()).resume_cursor);
  assert.match(await reader.next(), /"worker_status":"running"/);

  turn.status = "completed";
  notify();
  const result = await reader.next();
  assert.match(result, /"type":"result","uuid":"first:result"/);
  assert.doesNotMatch(result, /Add a coverage test/);
  const before = await history();

  const text = "Add a coverage test";
  conversation.promptSuggestion = { turnId: turn.id, text };
  notify();
  const suggestion = await reader.next();
  assert.match(suggestion, /event: client_event\ndata: \{"source":"worker","payload":\{"session_id":"session_[a-f0-9]{32}","type":"prompt_suggestion","suggestion":"Add a coverage test"\}\}/);
  assert.doesNotMatch(suggestion, /^id:|sequence_num|event_id/m);
  assert.deepEqual(await history(), before);

  const replay = await open("0");
  assert.doesNotMatch(await replay.next(), /Add a coverage test/);
  assert.match(await replay.next(), /"type":"result","uuid":"first:result"[\s\S]+"type":"prompt_suggestion","suggestion":"Add a coverage test"/);
  await replay.close();
  const resumed = await open(`${before.resume_cursor}:${before.data.at(-1).event_id}`);
  const resumption = await resumed.next();
  assert.match(resumption, /"type":"prompt_suggestion","suggestion":"Add a coverage test"/);
  assert.doesNotMatch(resumption, /^id:|"type":"result"/m);
  await resumed.close();

  await new Promise<void>((resolve) => {
    batchRead = resolve;
    notify();
  });
  batchRead = undefined;
  const nextTurn: Turn = { ...turn, id: "second", prompt: "Change the test", status: "inProgress", items: [] };
  conversation.turns.push(nextTurn);
  notify();
  const running = await reader.next();
  assert.match(running, /"worker_status":"running"/);
  assert.match(running, /"type":"prompt_suggestion","suggestion":""/);
  assert.doesNotMatch(running, /Add a coverage test/);

  nextTurn.status = "completed";
  notify();
  const secondResult = await reader.next();
  assert.match(secondResult, /"type":"result","uuid":"second:result"/);
  assert.doesNotMatch(secondResult, /Add a coverage test/);

  conversation.promptSuggestion = { turnId: nextTurn.id, text };
  notify();
  assert.match(await reader.next(), /"type":"prompt_suggestion","suggestion":"Add a coverage test"/);
  settings.ccPromptSuggestions = false;
  notify({ type: "settings", settings });
  assert.match(await reader.next(), /"type":"prompt_suggestion","suggestion":""/);
  const disabled = await open((await history()).resume_cursor);
  assert.doesNotMatch(await disabled.next(), /Add a coverage test/);
});

test("Cloud Code lists and paginates only the selected routine's owned runs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-cloud-runs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = { id: "routine-owner", name: "Owner", email: "owner@example.invalid" };
  const routineId = "abc1af48-c08f-45cb-9ae2-0465fedfaee7";
  const otherRoutineId = "9bc8de16-48ae-49a6-a362-79a5817d446b";
  const trigger = `trig_${routineId}`;
  const other = `trig_${otherRoutineId}`;
  const routineRuns = Array.from({ length: 31 }, (_, index): Conversation => ({
    id: `run-${index}`,
    mode: "code",
    title: `Run ${index}`,
    providerId: "runner",
    model: "code-model",
    createdAt: index,
    updatedAt: 100 - index,
    pinned: false,
    archived: false,
    scheduledRun: true,
    scheduledTaskId: routineId,
    turns: [{
      id: `turn-${index}`, prompt: "Run routine", createdAt: index, attachments: [], items: [],
      status: index === 30 ? "failed" : index === 29 ? "inProgress" : "completed",
    }],
  }));
  const sample = routineRuns[0];
  const conversations: Conversation[] = [
    ...routineRuns,
    { ...sample, id: "other-routine", title: "Other routine", scheduledTaskId: otherRoutineId },
    { ...sample, id: "regular", title: "Regular Code", scheduledTaskId: undefined },
    { ...sample, id: "private", title: "Private", incognito: true },
    { ...sample, id: "mirrored", title: "Mirrored", cloudHosted: true },
    { ...sample, id: "other-owner", title: "Other owner", sessionAuthors: {
      ownerAccountUuid: "other", viewerAccountUuid: owner.id,
    } },
    { ...sample, id: "cowork", title: "Cowork", mode: "cowork", environment: {
      kind: "space", spaceId: "cowork-space",
    } },
  ];
  const bridge = createRunnerOfficialAdapter({
    account: () => owner,
    settings: () => ({}),
    sessionIdentity: () => owner,
    stateDirectory: () => root,
    log() {},
  } as never, async (method) => {
    assert.equal(method, "snapshot");
    return { conversations };
  }, root, { modes: ["code", "cowork"] });
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid", bridge,
    async () => assert.fail("Scheduled run history escaped the Web bridge"),
  );
  const list = "/v1/code/sessions";
  const get = (path: string) =>
    fetch(path, { headers: { "x-organization-uuid": organizationUuid(owner.id) } });
  const query = `${list}?trigger_id=${trigger}&limit=30`;
  const response = await get(query);
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.deepEqual(first.data.map((row: { title: string }) => row.title),
    Array.from({ length: 30 }, (_, index) => `Run ${30 - index}`));
  assert.ok(first.data.every((row: { trigger_id: string }) => row.trigger_id === trigger));
  assert.equal(first.data[0].status_bucket, "failed");
  assert.equal(first.data[1].status_bucket, "working");
  assert.equal(first.has_more, true);
  assert.equal(first.last_id, first.data[29].id);
  assert.equal(first.next_cursor, first.last_id);

  const next = await get(`${query}&cursor=${first.last_id}`);
  assert.equal(next.status, 200);
  const last = await next.json();
  assert.equal(last.data.length, 1);
  assert.equal(last.data[0].title, "Run 0");
  assert.equal(last.has_more, false);
  assert.equal(last.last_id, null);
  assert.equal(last.next_cursor, null);
  assert.equal((await get(`${list}?trigger_id=${other}&limit=30&cursor=${first.last_id}`)).status, 404);

  const rollup = await get(`${list}?only_trigger_sessions=true&limit=200&exclude_tags=-`);
  assert.equal(rollup.status, 200);
  const page = await rollup.json();
  assert.equal(page.data.length, 32);
  assert.equal(page.data[0].id, first.data[0].id);
  assert.equal(page.data.filter((row: { trigger_id: string }) => row.trigger_id === other).length, 1);
  const detail = await get(`${list}/${first.data[0].id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).session.trigger_id, trigger);

  const cowork = await get(`${list}?tags=cowork-remote&include_trigger_sessions=true&limit=100`);
  assert.equal(cowork.status, 200);
  const coworkPage = await cowork.json();
  assert.equal(coworkPage.data.length, 1);
  assert.equal(coworkPage.data[0].title, "Cowork");
  assert.equal(coworkPage.data[0].trigger_id, undefined);
  assert.equal((await get(`${list}?trigger_id=${routineId}&limit=30`)).status, 501);
  assert.equal((await get(`${list}?trigger_id=${trigger}&trigger_id=${other}`)).status, 501);
  assert.equal((await get(`${list}?only_trigger_sessions=true&exclude_tags=ui:pinned`)).status, 501);
});

test("Cloud Code streams MCP and dynamic calls without advancing the history cursor", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-cloud-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = {
    id: "fixture-owner",
    name: "Owner",
    email: "owner@example.invalid",
  };
  const turn: Turn = {
    id: "mcp-turn",
    prompt: "Run both tools",
    createdAt: 10,
    attachments: [],
    status: "inProgress",
    items: [
      {
        id: "first",
        type: "mcpToolCall",
        status: "inProgress",
        lifecycleStatus: "inProgress",
        progress: "Connecting",
      },
    ],
  };
  const conversation: Conversation = {
    id: "mcp-session",
    mode: "code",
    title: "MCP session",
    cwd: root,
    model: "code-model",
    providerId: "runner",
    createdAt: 10,
    updatedAt: 10,
    pinned: false,
    archived: false,
    turns: [turn],
  };
  const host = {
    account: () => owner,
    settings: () => ({
      mcpServers: {
        "Field-Notes": {
          display_name: "Field Notes",
          url: "https://example.com/mcp",
          claudex_directory_id: "a2545dc6-cc30-4f5b-8482-96108b4c5142",
        },
      },
    }),
    stateDirectory: () => root,
    sessionIdentity: () => owner,
    onEvent: () => () => {},
    log() {},
  } as never;
  const bridge = createRunnerOfficialAdapter(
    host,
    async (method) => {
      if (method === "snapshot") return { conversations: [conversation] };
      if (method === "conversationTurns") return { turns: conversation.turns };
      assert.fail("Unexpected runner dispatch " + method);
    },
    root,
    { modes: ["code"] },
  );
  const listeners = new Set<(event: AppEvent) => void>();
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    bridge,
    async () => assert.fail("Cloud Code request escaped the Web bridge"),
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  );
  const emit = () =>
    listeners.forEach((listener) =>
      listener({
        type: "conversation-turn",
        conversationId: conversation.id,
        turn,
      }),
    );
  const org = organizationUuid(owner.id);
  const get = (query: string) =>
    fetch(query, { headers: { "x-organization-uuid": org } });
  const sessions = await (await get("/v1/code/sessions")).json();
  const events = "/v1/code/sessions/" + sessions.data[0].id + "/events";
  const live = events.replace("session_", "cse_") + "/stream";
  const history = async () => (await get(events + "?sort_order=asc")).json();
  assert.equal((await history()).resume_cursor, "1");

  const open = async (cursor: number) => {
    const response = await fetch(live, {
      headers: { "x-organization-uuid": org, "Last-Event-ID": String(cursor) },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    return reader;
  };
  const nextFrame = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
    new TextDecoder().decode((await reader.read()).value);
  const reader = await open(1);
  const opening = await nextFrame(reader);
  assert.match(opening, /"worker_status":"running"/);
  assert.doesNotMatch(opening, /"type":"tool_use"|Connecting|^id:/m);

  Object.assign(turn.items[0], {
    server: "Field-Notes",
    tool: "fixture_widget-v2",
    appContext: { resourceUri: "ui://fixture/widget.html" },
    arguments: { id: 1 },
  });
  const registeredTool = "mcp__3d7dbae0-89f2-4b6b-85c5-392460c543f9__fixture_widget-v2";
  emit();
  const first = await nextFrame(reader);
  assert.match(
    first,
    /"type":"message_start","message":\{"id":"mcp-turn:tool:first:use"/,
  );
  assert.ok(first.includes(`"id":"mcp-turn:tool:first","name":"${registeredTool}"`));
  assert.ok(
    first.includes(
      '"type":"input_json_delta","partial_json":' + JSON.stringify('{"id":1}'),
    ),
  );
  assert.doesNotMatch(first, /Connecting|^id:/m);

  turn.items.push({
    id: "second",
    type: "dynamicToolCall",
    tool: "fixtureFail",
    arguments: { id: 2 },
    lifecycleStatus: "inProgress",
  });
  emit();
  const second = await nextFrame(reader);
  assert.match(second, /"type":"content_block_start","index":1/);
  assert.match(
    second,
    /"id":"mcp-turn:tool:second","name":"fixtureFail"/,
  );
  assert.doesNotMatch(second, /message_start|^id:/m);
  assert.ok(!second.includes(registeredTool));
  assert.equal((await history()).resume_cursor, "1");

  await reader.cancel();
  const reconnected = await open(1);
  const preview = await nextFrame(reconnected);
  assert.ok(preview.includes(`"name":"${registeredTool}"`));
  assert.match(preview, /"name":"fixtureFail"/);
  assert.doesNotMatch(preview, /Connecting|^id:/m);

  Object.assign(turn.items[0], {
    status: "completed",
    lifecycleStatus: "completed",
    result: { content: [{ type: "text", text: "Tool succeeded" }] },
  });
  emit();
  const success = await nextFrame(reconnected);
  assert.match(success, /^id: 2\nevent: client_event/m);
  assert.match(
    success,
    /"message":\{"role":"assistant".*?"id":"mcp-turn:tool:first:use"\}/,
  );
  assert.ok(success.includes(`"name":"${registeredTool}"`));
  assert.match(success, /^id: 3\nevent: client_event/m);
  assert.match(
    success,
    /"tool_use_id":"mcp-turn:tool:first".*?"text":"Tool succeeded".*?"is_error":false/,
  );
  assert.match(
    success,
    /"type":"message_start","message":\{"id":"mcp-turn:tool:second:use"/,
  );
  assert.equal((await history()).resume_cursor, "3");

  Object.assign(turn.items[1], {
    status: "completed",
    lifecycleStatus: "completed",
    result: { content: [{ type: "text", text: "Tool failed" }], isError: true },
  });
  turn.status = "completed";
  emit();
  const failed = await nextFrame(reconnected);
  assert.match(failed, /^id: 4\nevent: client_event/m);
  assert.match(
    failed,
    /"message":\{"role":"assistant".*?"id":"mcp-turn:tool:second:use"\}/,
  );
  assert.match(failed, /^id: 5\nevent: client_event/m);
  assert.match(
    failed,
    /"tool_use_id":"mcp-turn:tool:second".*?"text":"Tool failed".*?"is_error":true/,
  );
  assert.match(failed, /^id: 6\nevent: client_event/m);
  assert.doesNotMatch(failed, /content_block_start/);
  await reconnected.cancel();

  const resumed = await open(3);
  const resumedFrame = await nextFrame(resumed);
  assert.match(resumedFrame, /^id: 4\nevent: client_event/m);
  assert.match(
    resumedFrame,
    /"tool_use_id":"mcp-turn:tool:second".*?"is_error":true/,
  );
  assert.doesNotMatch(
    resumedFrame,
    /"uuid":"mcp-turn:tool:first|ephemeral_event/,
  );
  assert.equal((await history()).resume_cursor, "6");
  await resumed.cancel();

  const partial: Turn = {
    id: "stopped-turn",
    officialCodeEventId: "web-input-id",
    prompt: "Start the next turn",
    createdAt: 20,
    attachments: [],
    status: "inProgress",
    items: [{ id: "reply", type: "agentMessage", lifecycleStatus: "inProgress", text: "Partial reply" }],
  };
  conversation.turns.push(partial);
  const stopped = await open(6);
  const streamed = await nextFrame(stopped);
  assert.match(streamed, /"type":"message_start","message":\{"id":"stopped-turn:item:reply"/);
  partial.status = "interrupted";
  partial.userStopped = true;
  partial.items[0].lifecycleStatus = "interrupted";
  listeners.forEach((listener) => listener({ type: "conversation", conversation }));
  const settled = await nextFrame(stopped);
  assert.match(settled, /"worker_status":"idle"/);
  assert.match(settled, /"message":\{"role":"assistant".*?"id":"stopped-turn:item:reply"\}/);
  assert.match(settled, /"source":"worker","payload":\{"type":"user","uuid":"stopped-turn:user-interrupt"/);
  assert.match(settled, /"type":"result","uuid":"web-input-id:result"/);
  assert.doesNotMatch(settled, /event: delivery_update/);
  await stopped.cancel();

  const cursor = Number((await history()).resume_cursor);
  const reasoning: Turn["items"][number] = {
    id: "summary", type: "reasoning", lifecycleStatus: "inProgress",
    summary: ["Public preview"], content: ["Private fixture"],
  };
  const thinkingTurn: Turn = {
    id: "thinking-turn", prompt: "Think", createdAt: 30,
    attachments: [], status: "inProgress", items: [reasoning],
  };
  conversation.turns.push(thinkingTurn);
  const thinking = await open(cursor);
  assert.match(await nextFrame(thinking), /"type":"thinking_delta","thinking":"Public preview"/);
  await thinking.cancel();
  const resumedThinking = await open(cursor + 1);
  const resumedSummary = await nextFrame(resumedThinking);
  assert.match(resumedSummary, /"type":"thinking_delta","thinking":"Public preview"/);
  assert.doesNotMatch(resumedSummary, /Private fixture|^id:/m);
  reasoning.summary = [];
  reasoning.lifecycleStatus = "completed";
  listeners.forEach((listener) => listener({ type: "conversation", conversation }));
  const cleared = await nextFrame(resumedThinking);
  assert.match(cleared, /"type":"message_start","message":\{"id":"thinking-turn:item:summary".*?"content":\[\]/);
  assert.doesNotMatch(cleared, /Public preview|Private fixture|^id:/m);
  assert.equal((await history()).resume_cursor, String(cursor + 1));

  thinkingTurn.status = "completed";
  const compact: Turn = {
    id: "compact-turn",
    compaction: "manual",
    compactionRequestId: "786f59a5-e044-4404-b379-79b9109a3c87",
    createdAt: 31,
    prompt: "",
    attachments: [],
    items: [{ type: "contextCompaction", id: "compact", lifecycleStatus: "inProgress" }],
    status: "inProgress",
  };
  conversation.turns.push(compact);
  const beforeCompact = Number((await history()).resume_cursor);
  const compactStream = await open(beforeCompact);
  assert.match(await nextFrame(compactStream), /"status":"compacting"/);
  compact.status = "completed";
  compact.items[0].lifecycleStatus = "completed";
  listeners.forEach((listener) => listener({ type: "conversation", conversation }));
  const completed = await nextFrame(compactStream);
  assert.match(completed, /"subtype":"compact_boundary"/);
  assert.match(completed, /"type":"result","uuid":"786f59a5-e044-4404-b379-79b9109a3c87:result"/);
  assert.equal((await history()).resume_cursor, String(beforeCompact + 2));

  const retryTurn: Turn = {
    id: "retry-turn",
    prompt: "Resume the provider stream",
    createdAt: 32,
    attachments: [],
    items: [{ id: "retry-reply", type: "agentMessage", lifecycleStatus: "inProgress", text: "Unfinished reply" }],
    status: "inProgress",
  };
  conversation.turns.push(retryTurn);
  const retryFrom = Number((await history()).resume_cursor);
  const retryStream = await open(retryFrom);
  assert.match(await nextFrame(retryStream), /"text":"Unfinished reply"/);
  retryTurn.items = [];
  retryTurn.streamRetry = { attempt: 2, maxRetries: 5, cause: "overloaded" };
  emit();
  const retry = await nextFrame(retryStream);
  assert.match(retry, /"type":"message_start","message":\{"id":"retry-turn:item:retry-reply"[\s\S]*"type":"message_stop"[\s\S]*"subtype":"api_retry"/);
  assert.match(retry, /"subtype":"api_retry".*"attempt":2,"max_retries":5,"error":"overloaded"/);
  assert.doesNotMatch(retry, /Unfinished reply|^id:/m);
  assert.doesNotMatch(JSON.stringify(await history()), /api_retry/);

  await retryStream.cancel();
  const retryReopened = await open(retryFrom);
  assert.match(await nextFrame(retryReopened), /"subtype":"api_retry".*"attempt":2/);
  await retryReopened.cancel();

  delete retryTurn.streamRetry;
  retryTurn.items.push({ id: "recovered-reply", type: "agentMessage", lifecycleStatus: "inProgress", text: "Recovered reply" });
  const recovered = await open(retryFrom);
  const afterRetry = await nextFrame(recovered);
  assert.match(afterRetry, /"text":"Recovered reply"[\s\S]*"subtype":"api_retry_cleared"/);
  assert.doesNotMatch(afterRetry, /Unfinished reply|^id:/m);
  assert.equal((await history()).resume_cursor, String(retryFrom));
  await recovered.cancel();
});

test("original Cloud Code GETs reach only the current account's Code history", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-cloud-code-"));
  let engineStore: Store | undefined;
  t.after(() => {
    engineStore?.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const owner = {
    id: "fixture-owner",
    name: "Owner",
    email: "owner@example.invalid",
  };
  const org = organizationUuid(owner.id);
  const otherOrg = organizationUuid("other");
  const attachments = path.join(root, "attachments");
  fs.mkdirSync(attachments);
  const imagePath = path.join(attachments, "fixture.png");
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQT75LEmIY1TCqYfhqAADceF8Qtr3WKQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(imagePath, image);
  let identity = {};
  let retireWhileReading = false;
  const calls: [string, unknown[]][] = [];
  const base: Conversation = {
    id: "old Code session from before the official web adapter",
    mode: "code",
    title: "Open Code session",
    cwd: "/private/runner/profile/workspace",
    model: "code-model",
    providerId: "runner",
    repository: {
      fullName: "fixture-org/fixture-repo",
      url: "https://fixture-user:fixture-password@github.com/fixture-org/fixture-repo.git?fixture-query=private",
    },
    branch: "feature/sidebar",
    updatedAt: 50,
    createdAt: 10,
    pinned: false,
    archived: false,
    turns: [
      {
        id: "initial",
        prompt: "first question",
        createdAt: 10,
        attachments: [
          {
            id: "saved-image",
            name: "fixture.png",
            path: imagePath,
            kind: "image",
            size: image.length,
          },
        ],
        status: "completed",
        items: [{ type: "agentMessage", id: "answer", text: "first answer" }],
      },
      {
        id: "follow-up",
        prompt: "follow-up question",
        createdAt: 50,
        attachments: [],
        status: "inProgress",
        items: [
          {
            type: "commandExecution",
            id: "tool",
            status: "completed",
            command: "printf code-result",
            aggregatedOutput: "code-result",
            privateFixtureField: "must-not-leave-runner",
          },
        ],
      },
    ],
  };
  const inventory: Conversation[] = [
    base,
    { ...base, id: "pinned", pinned: true, updatedAt: 45, repository: undefined, branch: undefined },
    { ...base, id: "archived", archived: true, updatedAt: 30 },
    { ...base, id: "incognito", incognito: true },
    { ...base, id: "mirrored", cloudHosted: true },
    {
      ...base,
      id: "another-user",
      sessionAuthors: {
        ownerAccountUuid: "other",
        viewerAccountUuid: owner.id,
      },
    },
    { ...base, id: "chat", mode: "chat" },
  ];
  let heldInputs: { unreadInputUuids: string[]; sendsHeldAfterError: string[] } | undefined;
  const host = {
    account: () => owner,
    settings: () => ({}),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    officialCodeHeldInputs: (id: string) => id === base.id ? heldInputs : undefined,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  } as never;
  const dispatch = async (method: string, args: unknown[]) => {
    calls.push([method, args]);
    if (method === "snapshot") return { conversations: inventory };
    if (method === "memoryStatus") return undefined;
    if (method === "conversationTurns") {
      const owned = inventory.find((row) => row.id === args[0]);
      assert.ok(owned);
      if (retireWhileReading) identity = {};
      return { turns: owned.turns };
    }
    assert.fail("Unexpected runner dispatch " + method);
  };
  const bridge = createRunnerOfficialAdapter(host, dispatch, root, {
    modes: ["chat", "code"],
  });
  const listeners = new Set<(event: AppEvent) => void>();
  const emit = (event: AppEvent) =>
    listeners.forEach((listener) => listener(event));
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    bridge,
    async () => assert.fail("Cloud Code request escaped the Web bridge"),
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  );
  const listPath = "/v1/code/sessions";
  const get = (query: string, organization = org) =>
    fetch(query, { headers: { "x-organization-uuid": organization } });

  assert.equal((await get(listPath, otherOrg)).status, 404);
  assert.equal((await get(listPath + "?limit=1&limit=2")).status, 501);
  assert.equal((await get(listPath + "?unexpected=1")).status, 501);
  assert.deepEqual(calls, []);

  const account = await fetch("/api/account");
  assert.equal(account.status, 200);
  const profile = await account.json();
  assert.deepEqual(profile.claudex_web_code, {
    version: 1,
    account_uuid: owner.id,
    organization_uuid: org,
    available: true,
  });
  assert.equal(profile.claudex_local_code, undefined);
  assert.deepEqual(profile.memberships[0].organization.capabilities, ["chat"]);

  const first = await get(
    listPath + "?limit=1&statuses=active&include_pinned_beyond_page=true",
  );
  assert.equal(first.status, 200);
  const firstPage = await first.json();
  assert.equal(firstPage.data.length, 1);
  const key = firstPage.data[0].id;
  assert.match(key, /^session_[a-f0-9]{32}$/);
  assert.equal(firstPage.data[0].worker_status, "running");
  assert.equal(firstPage.data[0].environment_kind, "byoc");
  assert.match(firstPage.data[0].environment_id, /^env_[a-f0-9]{32}$/);
  assert.equal(firstPage.data[0].config.model, "code-model");
  const sources = [{
    type: "git_repository",
    url: "https://github.com/fixture-org/fixture-repo.git",
    revision: "refs/heads/feature/sidebar",
  }];
  assert.deepEqual(firstPage.data[0].config.sources, sources);
  assert.equal(firstPage.next_cursor, key);
  assert.equal(firstPage.pinned_beyond_page.sessions.length, 1);
  assert.doesNotMatch(
    JSON.stringify(firstPage),
    /private\/runner|incognito|mirrored|another-user|fixture-password|fixture-query/,
  );

  const next = await get(listPath + "?limit=1&statuses=active&cursor=" + key);
  const nextPage = await next.json();
  assert.equal(nextPage.data.length, 1);
  assert.deepEqual(nextPage.data[0].tags, ["ui:pinned"]);
  assert.equal(nextPage.data[0].config.sources, undefined);
  assert.equal(nextPage.next_cursor, null);

  const detail = await get(listPath + "/" + key.replace("session_", "cse_"));
  assert.equal(detail.status, 200);
  const selected = (await detail.json()).session;
  assert.equal(selected.id, key);
  assert.deepEqual(selected.config.sources, sources);
  assert.deepEqual(selected.external_metadata.current_branches, {
    "fixture-org/fixture-repo": "feature/sidebar",
  });

  base.sessionRepositories = [
    { url: base.repository!.url },
    { url: "https://github.com/fixture-org/second", ref: "refs/heads/other" },
    { url: "https://github.com/fixture-org/tagged", ref: "refs/tags/v1" },
    { url: "https://github.com/fixture-org/unresolved" },
  ];
  const multi = (await (await get(listPath + "/" + key)).json()).session;
  assert.deepEqual(multi.config.sources, [
    ...sources,
    { type: "git_repository", url: "https://github.com/fixture-org/second", revision: "refs/heads/other" },
    { type: "git_repository", url: "https://github.com/fixture-org/tagged", revision: "refs/tags/v1" },
    { type: "git_repository", url: "https://github.com/fixture-org/unresolved" },
  ]);
  assert.deepEqual(multi.external_metadata.current_branches, {
    "fixture-org/fixture-repo": "feature/sidebar",
  });
  assert.ok(multi.session_context.mcp_config);
  base.sessionRepositories = [
    { url: base.repository!.url, ref: "refs/heads/release", outcome: { kind: "create", branch: "Team_42/output" } },
    { url: "https://github.com/fixture-org/second", outcome: { kind: "create", branch: "Team_42/output" } },
  ];
  base.branch = "feature/checked-out";
  const withOutcomes = (await (await get(listPath + "/" + key)).json()).session;
  assert.deepEqual(withOutcomes.config.sources, [
    { ...sources[0], revision: "refs/heads/release" },
    { type: "git_repository", url: "https://github.com/fixture-org/second" },
  ]);
  assert.deepEqual(withOutcomes.config.outcomes, [
    { type: "git_repository", git_info: { type: "github", repo: "fixture-org/fixture-repo", branches: ["Team_42/output"] } },
    { type: "git_repository", git_info: { type: "github", repo: "fixture-org/second", branches: ["Team_42/output"] } },
  ]);
  assert.deepEqual(withOutcomes.external_metadata.current_branches, {
    "fixture-org/fixture-repo": "feature/checked-out",
  });
  base.pendingSetup = base.sessionRepositories;
  const pending = (await (await get(listPath + "/" + key)).json()).session;
  assert.equal(pending.external_metadata, undefined);
  delete base.pendingSetup;
  delete base.sessionRepositories;
  base.branch = "feature/sidebar";

  const events = listPath + "/" + key + "/events";
  const earlier = await get(events + "?limit=2&sort_order=asc");
  const earlierPage = await earlier.json();
  assert.equal(earlier.status, 200);
  assert.deepEqual(
    earlierPage.data.map((event: any) => event.sequence_num),
    [1, 2],
  );
  assert.deepEqual(
    earlierPage.data[0].payload.message.content.find(
      (block: any) => block.type === "image",
    )?.source,
    {
      type: "base64",
      media_type: "image/png",
      data: image.toString("base64"),
    },
  );
  assert.doesNotMatch(
    JSON.stringify(earlierPage),
    /fixture\.png|official-cloud-code-/,
  );
  assert.equal(earlierPage.data[0].source, "client");
  assert.equal(
    earlierPage.data[0].processing_at,
    earlierPage.data[0].created_at,
  );
  assert.equal(earlierPage.data[0].sent_by_account_id, owner.id);
  assert.equal(earlierPage.data[1].source, "worker");
  const later = await get(
    events + "?limit=500&sort_order=asc&cursor=" + earlierPage.next_cursor,
  );
  const laterPage = await later.json();
  assert.equal(later.status, 200);
  assert.equal(laterPage.data[0].sequence_num, 3);
  assert.equal(laterPage.data[0].payload.type, "result");
  assert.equal(laterPage.next_cursor, null);
  assert.equal(
    (
      await get(
        listPath +
          "/" +
          nextPage.data[0].id +
          "/events?cursor=" +
          earlierPage.next_cursor,
      )
    ).status,
    404,
  );
  assert.match(JSON.stringify(laterPage), /code-result/);
  assert.doesNotMatch(
    JSON.stringify(laterPage),
    /claudexSourceItem|must-not-leave-runner/,
  );
  assert.equal(
    (await get(events + "?cursor=evt_" + "0".repeat(64))).status,
    404,
  );

  const tail = await get(events + "?limit=2&sort_order=desc");
  const tailPage = await tail.json();
  assert.equal(tailPage.data[0].event_id, laterPage.data.at(-1).event_id);
  assert.equal(
    tailPage.data[0].sequence_num,
    tailPage.data[1].sequence_num + 1,
  );

  const backfill = await get(
    events + "?cursor=3&sort_order=asc&exclude_types=result",
  );
  assert.equal(backfill.status, 200);
  const recovered = await backfill.json();
  assert.equal(recovered.data[0].sequence_num, 4);
  assert.equal(
    recovered.resume_cursor,
    String(laterPage.data.at(-1).sequence_num),
  );
  assert.equal((await get(events + "?cursor=9999")).status, 410);

  const originalTurns = base.turns;
  base.turns = [0, 1].map((index) => ({
    id: "large-" + index,
    prompt: String(index).repeat(officialUiReadMaxBytes / 2),
    createdAt: 70 + index,
    attachments: [],
    status: "completed",
    items: [],
  }));
  const boundedQuery =
    events + "?limit=500&sort_order=asc&exclude_types=result";
  const bounded = await get(boundedQuery);
  assert.equal(bounded.status, 200);
  const boundedPage = await bounded.json();
  assert.equal(boundedPage.data.length, 1);
  assert.equal(boundedPage.data[0].sequence_num, 1);
  assert.ok(boundedPage.next_cursor);
  const boundedNext = await get(
    boundedQuery + "&cursor=" + boundedPage.next_cursor,
  );
  const boundedNextPage = await boundedNext.json();
  assert.equal(boundedNext.status, 200);
  assert.equal(boundedNextPage.data.length, 1);
  assert.equal(boundedNextPage.data[0].sequence_num, 3);
  assert.equal(boundedNextPage.next_cursor, null);
  base.turns[0].prompt = "x".repeat(officialUiReadMaxBytes);
  const oversized = await get(boundedQuery);
  assert.equal(oversized.status, 200);
  const oversizedPage = await oversized.json();
  assert.equal(oversizedPage.data.length, 1);
  assert.equal(oversizedPage.data[0].payload.message.content.length, officialUiReadMaxBytes);
  assert.equal(oversizedPage.next_cursor, boundedPage.next_cursor);
  base.turns = originalTurns;

  assert.equal(isOfficialUiAction("POST", events), true);
  assert.equal(
    (await fetch(events, { method: "POST", body: "{}" })).status,
    501,
  );
  assert.equal(isOfficialUiQuery("GET", events, "?limit=501"), false);
  const disabled = createRunnerOfficialAdapter(host, dispatch, root, {
    modes: ["chat"],
  });
  const before = calls.length;
  assert.equal((await disabled({ method: "GET", path: listPath })).status, 403);
  assert.equal(calls.length, before);
  const disabledProfile = await disabled({
    method: "GET",
    path: "/api/account",
  });
  assert.equal(
    JSON.parse(Buffer.from(disabledProfile.body).toString()).claudex_web_code,
    undefined,
  );
  const live = events.replace("session_", "cse_") + "/stream";
  const sequence = laterPage.data.at(-1).sequence_num;
  const streamPath = live + "?from_sequence_num=" + sequence;
  assert.equal((await get(streamPath, otherOrg)).status, 404);
  const replay = await get(live);
  const replayReader = replay.body!.getReader();
  t.after(() => replayReader.cancel());
  const replayFrame = new TextDecoder().decode(
    (await replayReader.read()).value,
  );
  assert.match(replayFrame, /event: delivery_update/);
  assert.match(replayFrame, /"status":"processed"/);
  assert.match(replayFrame, /id: 1\nevent: client_event/);
  assert.doesNotMatch(replayFrame, /conversation_id|private\/runner/);
  await replayReader.cancel();
  assert.equal(listeners.size, 0);
  const wrongAnchor = await bridge({
    method: "GET",
    path: streamPath + "&after_event_id=evt_" + "0".repeat(64),
    codeOrganizationId: org,
  });
  assert.equal(wrongAnchor.status, 410);
  assert.equal((await get(live + "?from_sequence_num=9999")).status, 410);
  assert.equal(
    (await get(live + "?from_sequence_num=1&from_sequence_num=2")).status,
    501,
  );
  const running = base.turns.at(-1)!;
  running.items.push(
    { id: `diff-${running.id}`, type: "diff", text: "aggregate diff" },
    {
      id: "streamed",
      type: "agentMessage",
      text: "progress",
      lifecycleStatus: "inProgress",
    },
  );
  const response = await get(streamPath);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  const nextFrame = async () =>
    new TextDecoder().decode((await reader.read()).value);
  const initial = await nextFrame();
  assert.match(initial, /event: session_update/);
  assert.match(initial, /"worker_status":"running"/);
  assert.match(initial, /event: ephemeral_event/);
  assert.match(initial, /"text":"progress"/);
  assert.match(initial, /event: client_event\ndata: .*"type":"system","subtype":"status","status":null/);
  assert.doesNotMatch(initial, /id: \d+\nevent: client_event|aggregate diff|private\/runner/);
  const readCount = calls.length;
  emit({ type: "conversation", conversation: inventory[1] });
  assert.equal(calls.length, readCount);
  running.items.at(-1)!.text = "progress plus more";
  emit({ type: "conversation-turn", conversationId: base.id, turn: running });
  const delta = await nextFrame();
  assert.match(delta, /"text":" plus more"/);
  assert.doesNotMatch(delta, /id: |message_start/);

  running.status = "completed";
  heldInputs = {
    unreadInputUuids: ["6d94e215-e2ac-437f-aa79-97da1808426e"],
    sendsHeldAfterError: ["6d94e215-e2ac-437f-aa79-97da1808426e"],
  };
  running.items.at(-1)!.lifecycleStatus = "completed";
  emit({ type: "conversation-turn", conversationId: base.id, turn: running });
  const final = await nextFrame();
  assert.match(final, /"worker_status":"idle"/);
  assert.match(
    final,
    new RegExp("id: " + (sequence + 1) + "\nevent: client_event"),
  );
  assert.match(final, /"text":"progress plus more"/);
  assert.match(final, /"type":"result"/);
  assert.ok(final.includes('"unreadInputUuids":' + JSON.stringify(heldInputs.unreadInputUuids)));
  assert.ok(final.includes('"sendsHeldAfterError":' + JSON.stringify(heldInputs.sendsHeldAfterError)));
  assert.equal(listeners.size, 1);
  await reader.cancel();
  assert.equal(listeners.size, 0);

  const abort = new AbortController();
  const reconnected = await fetch(live, {
    signal: abort.signal,
    headers: {
      "Last-Event-ID": String(sequence + 2),
      "x-organization-uuid": org,
    },
  });
  const resumed = reconnected.body!.getReader();
  t.after(() => resumed.cancel().catch(() => {}));
  const opening = new TextDecoder().decode((await resumed.read()).value);
  assert.match(opening, /event: session_update/);
  assert.match(opening, /event: client_event\ndata: .*"type":"system","subtype":"status","status":null/);
  assert.doesNotMatch(opening, /id: \d+\nevent: client_event|progress plus more/);
  abort.abort();
  await assert.rejects(resumed.read(), { name: "AbortError" });
  assert.equal(listeners.size, 0);

  const planTurn: Turn = {
    id: "planned-turn",
    prompt: "Follow the task list.",
    createdAt: 90,
    attachments: [],
    status: "inProgress",
    items: [],
  };
  base.turns.push(planTurn);
  engineStore = new Store(root);
  const engine = new Engine(engineStore, "unused", () => "", () => {});
  const planUpdate = (status: string, explanation: string) =>
    engine.applyTurnEvent(base, planTurn, "turn/plan/updated", {
      turnId: planTurn.id,
      plan: [{ step: "Inspect the code", status }],
      explanation,
    });
  const readLive = async (from: number, after?: string) => {
    const response = await bridge({
      method: "GET",
      path: live + "?from_sequence_num=" + from + (after ? "&after_event_id=" + after : ""),
      codeOrganizationId: org,
    });
    assert.equal(response.status, 200);
    return JSON.parse(Buffer.from(response.body).toString());
  };
  assert.equal(planUpdate("inProgress", "Reviewing the code"), true);
  const firstPlan = await readLive(sequence + 2);
  assert.equal(firstPlan.data.length, 3);
  assert.equal(firstPlan.data[1].payload.message.content[0].name, "TodoWrite");
  assert.equal(firstPlan.data[1].payload.message.content[0].input.todos[0].status, "in_progress");
  const planAnchor = firstPlan.data[2];

  engine.applyTurnEvent(base, planTurn, "item/agentMessage/delta", {
    itemId: "plan-answer", delta: "Found the relevant code.",
  });
  const duringPlan = await readLive(planAnchor.sequence_num, planAnchor.event_id);
  assert.equal(duringPlan.partial.text, "Found the relevant code.");
  planTurn.items.at(-1)!.lifecycleStatus = "completed";
  assert.equal(planUpdate("completed", "Review complete"), true);
  assert.equal(planUpdate("completed", "Review complete"), false);
  const afterPlan = await readLive(planAnchor.sequence_num, planAnchor.event_id);
  assert.equal(afterPlan.data.length, 3);
  assert.equal(afterPlan.data[0].payload.message.content[0].text, "Found the relevant code.");
  assert.equal(afterPlan.data[1].payload.message.content[0].input.todos[0].status, "completed");
  assert.match(afterPlan.data[2].payload.message.content[0].content, /Review complete/);
  assert.deepEqual((await readLive(sequence + 2)).data.slice(0, 3), firstPlan.data);

  planTurn.status = "completed";
  const settledPlan = await readLive(planAnchor.sequence_num, planAnchor.event_id);
  assert.deepEqual(settledPlan.data.slice(0, 3), afterPlan.data);
  assert.equal(settledPlan.data[3].payload.type, "result");
  assert.equal(planUpdate("pending", "Late update"), false);

  const legacyTurn: Turn = {
    id: "legacy-planned-turn",
    prompt: "A plan from an older build.",
    createdAt: 100,
    attachments: [],
    status: "inProgress",
    items: [
      { id: "plan-legacy-planned-turn", type: "taskPlan", plan: [{ step: "Legacy task", status: "pending" }] },
      { id: "legacy-text", type: "agentMessage", text: "Text after the older plan.", lifecycleStatus: "completed" },
      { id: "legacy-steer-item", type: "userMessage", steered: true, clientId: "legacy-steer", text: "Image steer", attachments: originalTurns[0].attachments },
      { id: "peer", type: "peerMessage", text: "A peer reported progress.", origin: { kind: "peer", name: "Reviewer" } },
    ],
  };
  base.turns.push(legacyTurn);
  const latestPlanResult = settledPlan.data.at(-1);
  const legacyLive = await readLive(latestPlanResult.sequence_num, latestPlanResult.event_id);
  assert.equal(legacyLive.data.length, 1);
  assert.equal(legacyLive.partial.text, "Text after the older plan.");
  legacyTurn.status = "completed";
  const legacyFinal = await readLive(latestPlanResult.sequence_num, latestPlanResult.event_id);
  assert.equal(legacyFinal.data[1].payload.message.content[0].name, "TodoWrite");
  assert.equal(legacyFinal.data[3].payload.message.content[0].text, "Text after the older plan.");
  const steer = legacyFinal.data[4];
  assert.equal(steer.payload.uuid, "legacy-steer");
  assert.equal(steer.payload.message.content[0].source.data, image.toString("base64"));
  const peer = legacyFinal.data[5];
  assert.equal(peer.payload.origin.name, "Reviewer");
  assert.equal(peer.source, "worker");
  assert.equal(peer.processing_at, undefined);

  const orphanTurn: Turn = {
    id: "searched-turn",
    prompt: "Search for the answer.",
    createdAt: 110,
    attachments: [],
    status: "inProgress",
    items: [
      { id: "sdk-search", type: "webSearch", query: "SDK search", status: "completed" },
      { id: "unknown-record", type: "fixtureUnknown", lifecycleStatus: "completed" },
      { id: "search-before", type: "agentMessage", text: "Searching.", lifecycleStatus: "completed" },
    ],
  };
  base.turns.push(orphanTurn);
  base.threadId = "search-thread";
  engine.store.conversations = [base];
  engine.routes.set(base.threadId, base.id);
  engine.signals.webSources({
    threadId: base.threadId,
    kind: "search",
    callId: "orphan-search",
    tool: "web_search",
    status: "completed",
    queries: ["fixture query"],
    sources: [],
  });
  engine.signals.webSources({
    threadId: base.threadId,
    kind: "search",
    callId: "sdk-search",
    tool: "web_search",
    status: "completed",
    queries: ["SDK search"],
    sources: [],
  });
  engine.signals.generatedImage({
    threadId: base.threadId,
    callId: "gateway-image",
    base64: image.toString("base64"),
    format: "png",
  });
  orphanTurn.items.push({ id: "search-answer", type: "agentMessage", text: "Found an answer.", lifecycleStatus: "completed" });
  const previousSequence = legacyFinal.data.at(-1).sequence_num;
  const beforeSettlement = await readLive(previousSequence);
  assert.equal(beforeSettlement.data[1].payload.message.content[0].input.query, "SDK search");
  assert.equal(beforeSettlement.data[3].payload.uuid, "searched-turn:item:unknown-record");
  assert.equal(beforeSettlement.data[3].payload.type, "system");
  assert.deepEqual(beforeSettlement.data[3].payload.message.content, []);
  const searchStream = await get(live + "?from_sequence_num=" + previousSequence);
  assert.equal(searchStream.status, 200);
  const searchReader = searchStream.body!.getReader();
  t.after(() => searchReader.cancel());
  assert.match(new TextDecoder().decode((await searchReader.read()).value), /Found an answer/);
  orphanTurn.status = "completed";
  engine.signals.settleOrphanSearches(base.threadId, orphanTurn);
  engine.signals.settleGeneratedImages(orphanTurn);
  assert.deepEqual(orphanTurn.items.map(({ id }) => id), [
    "sdk-search", "unknown-record", "orphan-search", "search-before", "gateway-image", "search-answer",
  ]);
  emit({ type: "conversation-turn", conversationId: base.id, turn: orphanTurn });
  const searchFrame = new TextDecoder().decode((await searchReader.read()).value);
  assert.match(searchFrame, /fixture query/);
  assert.match(searchFrame, /SendUserFile/);
  assert.match(searchFrame, /"type":"result"/);
  assert.doesNotMatch(searchFrame, /catch_up_truncated|Found an answer|SDK search/);
  await searchReader.cancel();
  const refreshed = await get(events + "?sort_order=asc&cursor=" + previousSequence);
  assert.equal(refreshed.status, 200);
  const refreshedPage = await refreshed.json();
  assert.deepEqual(refreshedPage.data.slice(0, beforeSettlement.data.length), beforeSettlement.data);
  const late = refreshedPage.data.slice(beforeSettlement.data.length);
  assert.equal(late[0].payload.message.content[0].input.query, "fixture query");
  assert.equal(late[2].payload.message.content[0].name, "SendUserFile");
  const imageTile = late[3].payload.tool_use_result.attachments[0];
  assert.equal(imageTile.path, "gateway-image.png");
  assert.equal(imageTile.isImage, true);
  assert.ok(imageTile.file_uuid);
  const imageDownload = await get(`/api/organizations/${org}/files/${imageTile.file_uuid}/contents`);
  assert.equal(imageDownload.status, 200);
  assert.ok(Buffer.from(await imageDownload.arrayBuffer()).equals(image));
  const reopened = await get(live + "?from_sequence_num=" + refreshedPage.resume_cursor);
  const reopenedReader = reopened.body!.getReader();
  t.after(() => reopenedReader.cancel());
  const refreshedFrame = new TextDecoder().decode((await reopenedReader.read()).value);
  assert.match(refreshedFrame, /"worker_status":"idle"/);
  assert.doesNotMatch(refreshedFrame, /id: \d+\nevent: client_event/);
  await reopenedReader.cancel();

  const shell: Turn = {
    id: "shell-turn",
    shell: true,
    prompt: "printf shell-output",
    createdAt: 120,
    attachments: [],
    status: "inProgress",
    items: [{ id: "shell-output", type: "commandExecution", source: "userShell", command: "printf shell-output", status: "inProgress" }],
  };
  base.turns.push(shell);
  const shellFrom = Number(refreshedPage.resume_cursor);
  assert.deepEqual((await readLive(shellFrom)).data, []);
  shell.items[0].aggregatedOutput = "shell-output";
  shell.items[0].status = "completed";
  shell.status = "completed";
  const shellHistory = await readLive(shellFrom);
  assert.equal(shellHistory.data.length, 2);
  assert.match(shellHistory.data[0].payload.message.content, /<bash-stdout>shell-output<\/bash-stdout>/);
  assert.equal(shellHistory.data[1].payload.type, "result");

  const compact: Turn = {
    id: "compact-turn",
    compaction: "manual",
    prompt: "",
    createdAt: 130,
    attachments: [],
    status: "inProgress",
    items: [{ id: "compact-item", type: "contextCompaction", lifecycleStatus: "completed" }],
  };
  base.turns.push(compact);
  const compactFrom = shellHistory.data[1].sequence_num;
  assert.deepEqual((await readLive(compactFrom)).data, []);
  compact.status = "failed";
  const failedCompact = await readLive(compactFrom);
  assert.equal(failedCompact.data.length, 1);
  assert.equal(failedCompact.data[0].payload.subtype, "status");
  assert.equal(failedCompact.data[0].payload.status, null);
  assert.equal(failedCompact.data[0].payload.compact_result, "failed");

  const anchor = failedCompact.data[0];
  const reconnect = (lastEventId: string) => fetch(
    live + "?from_sequence_num=" + anchor.sequence_num,
    { headers: { "Last-Event-ID": lastEventId, "x-organization-uuid": org } },
  );
  const reconnectFrame = async (lastEventId: string) => {
    const response = await reconnect(lastEventId);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    return { reader, read };
  };
  const cursor = `${anchor.sequence_num}:${anchor.event_id}`;
  const same = await reconnectFrame(cursor);
  assert.doesNotMatch(await same.read(), /catch_up_truncated|^id:/m);
  await same.reader.cancel();
  assert.equal((await reconnect(`0:${anchor.event_id}`)).status, 400);

  base.turns[base.turns.length - 1] = {
    id: "rewritten-tail", prompt: "A different turn occupies the old sequence",
    createdAt: 131, attachments: [], items: [], status: "completed",
  };
  assert.equal((await bridge({
    method: "GET",
    path: `${live}?from_sequence_num=${anchor.sequence_num}&after_event_id=${anchor.event_id}`,
    codeOrganizationId: org,
  })).status, 410);
  const rewritten = await reconnectFrame(cursor);
  assert.match(await rewritten.read(), /^id: 0\nevent: catch_up_truncated/m);
  assert.match(await rewritten.read(), /A different turn occupies the old sequence/);
  await rewritten.reader.cancel();

  const rewound = await reconnectFrame("0");
  assert.match(await rewound.read(), /^id: 1\nevent: client_event/m);
  await rewound.reader.cancel();

  const currentPrefix = (await readLive(0)).data[0];
  const rolledBack = await reconnectFrame(`${currentPrefix.sequence_num}:${currentPrefix.event_id}`);
  assert.match(await rolledBack.read(), /^id: 2\nevent: client_event/m);
  await rolledBack.reader.cancel();

  retireWhileReading = true;
  await assert.rejects(get(events), /account changed/i);
});
