import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import type { AppEvent, Conversation, Turn } from "../../shared/types";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";

const origin = "https://example.test";
const organization = "11111111-1111-4111-8111-111111111111";
const watchPath = "/v1/code/sessions/watch?exclude_tags=-";
const date = "2026-11-12T12:00:00.000Z";
const session = (id: string, title: string, status = "active") => ({
  id: `session_${id}`,
  title,
  status,
  worker_status: "idle",
  environment_id: "env_runner",
  environment_kind: "byoc",
  created_at: date,
  last_event_at: date,
});
const original = session("first", "Before");
const deleted = session("second", "Delete me");
const archived = { ...original, title: "Renamed", status: "archived" };
const added = session("third", "New Code session");
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: new TextEncoder().encode(JSON.stringify(body)),
});

function fixture(
  read?: (request: OfficialUiReadRequest) => Promise<ReturnType<typeof json>>,
) {
  const listeners = new Set<(event: AppEvent) => void>();
  const reads: OfficialUiReadRequest[] = [];
  let rows = [original, deleted];
  const fetch = createOfficialReadFetch(
    origin,
    async (request) => {
      reads.push(request);
      if (read) return read(request);
      const cursor = new URL(request.path, origin).searchParams.get("cursor");
      const first = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      return json({
        data: [rows[first]],
        next_cursor: first === 0 ? rows[0].id : null,
      });
    },
    async () => {
      throw Error("Unexpected native fetch.");
    },
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  );
  return {
    fetch,
    reads,
    listeners,
    emit(event: AppEvent) {
      listeners.forEach((listener) => listener(event));
    },
    changeRows() {
      rows = [archived, added];
    },
  };
}

async function readLifecycleFrames() {
  const f = fixture();
  const response = await f.fetch(watchPath, {
    headers: { "x-organization-uuid": organization },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  const sync = (await reader.read()).value;
  f.changeRows();
  f.emit({ type: "stream-connection", connected: true });
  const lifecycle = (await reader.read()).value;
  f.emit({
    type: "signed-out",
    reason: "session-expired",
    message: "Signed out",
  });
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.equal(f.listeners.size, 0);
  assert.ok(sync && lifecycle);
  assert.deepEqual(
    f.reads.map(({ path, codeOrganizationId }) => [path, codeOrganizationId]),
    [
      ["/v1/code/sessions?limit=500", organization],
      ["/v1/code/sessions?limit=500&cursor=session_first", organization],
      ["/v1/code/sessions?limit=500", organization],
      ["/v1/code/sessions?limit=500&cursor=session_first", organization],
    ],
  );
  return [sync, lifecycle];
}

test("official Code list watch streams scoped session lifecycle across list pages", async () => {
  const [sync, lifecycle] = await readLifecycleFrames();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode(sync), "event: sync\ndata: {}\n\n");
  assert.equal(
    decoder.decode(lifecycle),
    [
      `event: changed\ndata: ${JSON.stringify(archived)}\n\n`,
      `event: added\ndata: ${JSON.stringify(added)}\n\n`,
      `event: removed\ndata: ${JSON.stringify({ id: deleted.id })}\n\n`,
    ].join(""),
  );
});

test("Code watch reads when a turn starts and settles, without reading on its text deltas", async () => {
  let row = original;
  const f = fixture(async () => json({ data: [row], next_cursor: null }));
  const response = await f.fetch(watchPath);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  const turn: Turn = {
    id: "turn",
    prompt: "Write code",
    attachments: [],
    items: [],
    status: "inProgress",
    createdAt: 1,
  };
  const conversation: Conversation = {
    id: "first",
    title: row.title,
    mode: "code",
    model: "fixture",
    providerId: "fixture",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [turn],
  };
  row = { ...row, worker_status: "running" };
  f.emit({ type: "conversation", conversation });
  assert.match(
    decoder.decode((await reader.read()).value),
    /"worker_status":"running"/,
  );
  for (let updatedAt = 2; updatedAt < 5; updatedAt++)
    f.emit({
      type: "conversation",
      conversation: {
        ...conversation,
        updatedAt,
        turns: [
          {
            ...turn,
            items: [
              {
                id: "reply",
                type: "agentMessage",
                text: `Output ${updatedAt}`,
              },
            ],
          },
        ],
      },
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reads.length, 2);
  row = { ...row, worker_status: "idle" };
  f.emit({
    type: "conversation",
    conversation: {
      ...conversation,
      updatedAt: 5,
      turns: [{ ...turn, status: "completed" }],
    },
  });
  assert.match(
    decoder.decode((await reader.read()).value),
    /"worker_status":"idle"/,
  );
  await reader.cancel();
  assert.equal(f.listeners.size, 0);
});

test("an unauthorized Code list cannot open a watch", async () => {
  const f = fixture(async () =>
    json({ error: "Organization not found." }, 404),
  );
  assert.equal((await f.fetch(watchPath)).status, 404);
  assert.equal((await f.fetch(`${watchPath}&other=1`)).status, 501);
  assert.equal(f.reads.length, 1);
  assert.equal(f.listeners.size, 0);
});

test("aborting an opening Code watch releases its subscription during the list read", async () => {
  let resolveRead!: (response: ReturnType<typeof json>) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = f.fetch(watchPath, { signal: controller.signal });
  assert.equal(f.listeners.size, 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.listeners.size, 0);
  resolveRead(json({ data: [original], next_cursor: original.id }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reads.length, 1);
});

const assets = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
test(
  "the pinned original SSE parser consumes the Code watch frames",
  { skip: !assets },
  async () => {
    assert.ok(assets);
    const directory = join(assets, "cloud", "assets", "v1");
    const source = readFileSync(
      join(directory, "shared-m-4-CbJwwS_m.js"),
      "utf8",
    );
    const vendor = readFileSync(
      join(directory, "vendor-all-m-0-B3gemy7o.js"),
      "utf8",
    );
    const between = (text: string, start: string, end: string) => {
      const a = text.indexOf(start);
      const b = text.indexOf(end, a + start.length);
      assert.ok(
        a >= 0 && b > a,
        `Missing original source between ${start} and ${end}`,
      );
      return text.slice(a, b);
    };
    const syncs: string[] = [];
    const rows = new Map<string, unknown>([[deleted.id, deleted]]);
    const watch = {
      abortController: new AbortController(),
      dataFrameSeq: 0,
      connected: false,
    };
    let consume: ((chunk: Uint8Array) => void) | undefined;
    let options:
      | {
          onopen: (response: Response) => Promise<void>;
          onmessage: (frame: unknown) => void;
        }
      | undefined;
    runInNewContext(
      [
        between(vendor, "function n(e) {", "var o ="),
        between(source, "function gS(e, t) {", "function b1(e) {"),
        between(source, "function bG(e) {", "function kw(e) {"),
        between(source, "function nO(e) {", "function K7(e) {"),
        between(source, "function bK(e, t) {", "function FT(e, t, n) {"),
        `bK(watch, organization); install(n(r(getOptions().onmessage)));`,
      ].join("\n"),
      {
        TextDecoder,
        Uint8Array,
        organization,
        watch,
        Nu(path: string, supplied: typeof options) {
          assert.equal(path, watchPath);
          options = supplied;
          return Promise.resolve();
        },
        install(parser: typeof consume) {
          consume = parser;
        },
        getOptions: () => options,
        $Y: () => ({}),
        Iu: () => ({}),
        _K: () => false,
        O5: () => false,
        Wu: 0,
        CN: new Map(),
        Ta: new Set(),
        hX: () => {},
        Ee: () => {},
        e4: () => [],
        setTimeout: () => 0,
        yH: 0,
        II: (value: unknown) => typeof value === "object" && value !== null,
        Ht: (id: string) => syncs.push(id),
        ff: (_organization: string, _lineage: number, parse: () => unknown) =>
          parse(),
        DT: (
          _watch: unknown,
          _organization: string,
          event:
            | { kind: "upsert"; session: { id: string } }
            | { kind: "remove"; sessionId: string },
        ) => {
          if (event.kind === "upsert")
            rows.set(event.session.id, event.session);
          else rows.delete(event.sessionId);
        },
        K6: () => {},
      },
    );
    assert.ok(consume && options);
    await options.onopen(
      new Response(null, { headers: { "Content-Type": "text/event-stream" } }),
    );
    for (const chunk of await readLifecycleFrames()) consume(chunk);
    assert.equal(watch.connected, true);
    assert.deepEqual(syncs, [organization]);
    assert.deepEqual(Array.from(rows.keys()), [archived.id, added.id]);
    assert.equal(Reflect.get(rows.get(archived.id)!, "title"), "Renamed");
    assert.equal(
      Reflect.get(rows.get(archived.id)!, "session_status"),
      "archived",
    );
    assert.equal(Reflect.get(rows.get(added.id)!, "session_status"), "idle");
  },
);
