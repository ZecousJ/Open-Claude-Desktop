import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import type { SendInput } from "../../electron/engine/new-conversation";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import type { SkillReference } from "../../shared/skill-references";

const connectorId = "12345678-1234-4234-8234-123456789abc";
const local = (text: string, name: string, from = 0): SkillReference => {
  const start = text.indexOf(`/${name}`, from);
  return { kind: "local", name, start, end: start + name.length + 1 };
};
const remote = (text: string, name: string): SkillReference => {
  const token = `/${connectorId}:${name}`;
  const start = text.indexOf(token);
  return {
    kind: "remote",
    connectorId,
    name,
    start,
    end: start + token.length,
  };
};
const rpcText = (text: string) => ({ type: "text", text, text_elements: [] });

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f039-skill-"));
  const store = new Store(root);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const calls: { method: string; params: any }[] = [];
  const row = (name: string) => ({
    name,
    path: path.join(root, "skills", name, "SKILL.md"),
    enabled: true,
  });
  const catalog = (...names: string[]) => ({
    data: [{ skills: names.map(row) }],
  });
  let listing: unknown = catalog("review", "演示");
  let active = true;
  let beforeList = async () => {};
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  engine.rpc = {
    async call(method: string, params: unknown) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "skills/list") {
        await beforeList();
        return structuredClone(listing);
      }
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${calls.length}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as never;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    engine,
    row,
    catalog,
    starts: () => calls.filter((call) => call.method === "turn/start"),
    reads: () => calls.filter((call) => call.method === "skills/list"),
    setListing: (value: unknown) => {
      listing = value;
    },
    onList: (fn: typeof beforeList) => {
      beforeList = fn;
    },
    retire: () => {
      active = false;
    },
    send: (
      text: string,
      skillReferences?: SkillReference[],
      extra: Partial<SendInput> = {},
    ) =>
      engine.send(
        {
          text,
          skillReferences,
          mode: "chat",
          providerId: "default",
          model: "m",
          attachments: [],
          ...extra,
        },
        undefined,
        false,
        { current: () => active },
      ),
    complete: (id: string) => {
      const turn = store.conversation(id).turns.at(-1)!;
      turn.status = "completed";
      return turn;
    },
  };
}

for (const mode of ["chat", "cowork", "code"] as const)
  test(`${mode} loads distinct selected skills in prompt order and preserves history across restart`, async (t) => {
    const f = fixture(t);
    const text = "🔎 use /review, then /演示. Keep literal /review.";
    const references = [local(text, "review"), local(text, "演示")];
    const c = await f.send(text, references, { mode });
    const review = f.row("review");
    const chinese = f.row("演示");
    assert.deepEqual(f.starts()[0].params.input, [
      rpcText(text),
      { type: "skill", name: review.name, path: review.path },
      { type: "skill", name: chinese.name, path: chinese.path },
    ]);
    assert.deepEqual(
      f.reads().map((call) => call.params),
      [
        { cwds: [c.cwd], forceReload: true },
        { cwds: [c.cwd], forceReload: true },
      ],
    );
    f.store.flush();
    const turn = new Store(f.root).conversation(c.id).turns[0];
    assert.equal(turn.prompt, text);
    assert.equal(turn.rawOriginals, undefined);
    assert.deepEqual(turn.skillReferences, references);
    assert.deepEqual(turn.skillInvocations, [
      { kind: "local", name: review.name, path: review.path },
      { kind: "local", name: chinese.name, path: chinese.path },
    ]);
  });

test("ordinary slash text never consults the skills catalog", async (t) => {
  const f = fixture(t);
  for (const text of [
    "/review task",
    "Use /review in a sentence",
    "/path/to/file",
    "/12345678-1234-4234-8234-123456789abc:review",
    "\\/review",
    "`/review`",
    "$review",
  ]) {
    await f.send(text);
    assert.deepEqual(f.starts().at(-1)!.params.input, [rpcText(text)]);
    f.complete(f.store.conversations[0].id);
  }
  assert.equal(f.reads().length, 0);
});

test("range mismatch and duplicate spans never reach runtime", async (t) => {
  const f = fixture(t);
  const text = "🔎 /review";
  const ref = local(text, "review");
  await assert.rejects(
    f.send(text, [{ ...ref, start: ref.start - 1 }]),
    /no longer matches/,
  );
  await assert.rejects(f.send(text, [ref, ref]), /no longer matches/);
  assert.equal(f.reads().length, 0);
  assert.equal(f.starts().length, 0);
});

test("a repeated selection loads once and attachment slash text remains literal", async (t) => {
  const f = fixture(t);
  const text = "/review and /review";
  const file = path.join(f.root, "input.txt");
  const contents = "user attachment /演示 literal";
  fs.writeFileSync(file, contents);
  await f.send(text, [local(text, "review"), local(text, "review", 1)], {
    attachments: [
      {
        id: "file",
        name: "input.txt",
        path: file,
        kind: "text",
        size: Buffer.byteLength(contents),
      },
    ],
  });
  const input = f.starts()[0].params.input;
  assert.deepEqual(
    input.filter((part: { type: string }) => part.type === "skill"),
    [{ type: "skill", name: "review", path: f.row("review").path }],
  );
  assert.match(input[1].text, /user attachment \/演示 literal/);
});

test("an unrelated invalid skill file does not make a selected healthy skill unusable", async (t) => {
  const f = fixture(t);
  const text = "/review task";
  f.setListing({
    data: [
      {
        skills: [f.row("review"), f.row("review")],
        errors: [{ message: "invalid name" }],
      },
    ],
  });
  await f.send(text, [local(text, "review")]);
  assert.equal(
    f
      .starts()[0]
      .params.input.filter((part: { type: string }) => part.type === "skill")
      .length,
    1,
  );
});

for (const label of [
  "disabled",
  "missing",
  "ambiguous",
  "relative path",
  "bad row",
  "foreign cwd",
  "offline",
] as const)
  test(`${label} selection never reaches turn/start`, async (t) => {
    const f = fixture(t);
    const text = "/review task";
    const row = f.row("review");
    if (label === "disabled")
      f.setListing({ data: [{ skills: [{ ...row, enabled: false }] }] });
    if (label === "missing") f.setListing(f.catalog());
    if (label === "ambiguous")
      f.setListing({
        data: [
          {
            skills: [row, { ...row, path: path.resolve("elsewhere/SKILL.md") }],
          },
        ],
      });
    if (label === "relative path")
      f.setListing({
        data: [{ skills: [{ ...row, path: "relative/SKILL.md" }] }],
      });
    if (label === "bad row")
      f.setListing({ data: [{ skills: [{ name: "review" }] }] });
    if (label === "foreign cwd")
      f.setListing({
        data: [{ cwd: path.resolve("unrelated"), skills: [row] }],
      });
    if (label === "offline")
      f.onList(async () => {
        throw Error("offline");
      });
    await assert.rejects(
      f.send(text, [local(text, "review")]),
      /disabled|installed|ambiguous|incomplete|different folder|could not be read/,
    );
    assert.equal(f.starts().length, 0);
  });

test("Chat code execution gates both local and remote skill selection", async (t) => {
  const f = fixture(t);
  f.store.settings.chatExecution = false;
  const text = `/review /${connectorId}:custom`;
  f.engine.remoteConnectorSkill = async () =>
    assert.fail("cannot load remote skill with execution off");
  await assert.rejects(
    f.send(text, [local(text, "review"), remote(text, "custom")]),
    /code execution is off/,
  );
  assert.equal(f.reads().length, 0);
  assert.equal(f.starts().length, 0);
});

for (const change of [
  "disabled",
  "removed",
  "replaced",
  "runtime",
  "account",
] as const)
  test(`${change} after preparation never dispatches and retains resolved identity`, async (t) => {
    const f = fixture(t);
    const original = f.engine.ensureThread.bind(f.engine);
    f.engine.ensureThread = async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (change === "disabled")
        f.setListing({
          data: [{ skills: [{ ...f.row("review"), enabled: false }] }],
        });
      if (change === "removed") f.setListing(f.catalog());
      if (change === "replaced")
        f.setListing({
          data: [
            {
              skills: [
                {
                  ...f.row("review"),
                  path: path.resolve("replacement/SKILL.md"),
                },
              ],
            },
          ],
        });
      if (change === "runtime")
        f.engine.rpc = {
          call: async () =>
            assert.fail("replacement runtime must not be called"),
        } as never;
      if (change === "account") f.retire();
    };
    const text = "/review task";
    await assert.rejects(
      f.send(text, [local(text, "review")]),
      /disabled|changed|removed/,
    );
    assert.equal(f.starts().length, 0);
    const turn = f.store.conversations[0].turns[0];
    assert.deepEqual(turn.skillInvocations, [
      { kind: "local", name: "review", path: f.row("review").path },
    ]);
  });

test("follow-up, retry and edit preserve selected identities, and edited plain text can remove selection", async (t) => {
  const f = fixture(t);
  const text = "use /review and /演示, please";
  const selected = [local(text, "review"), local(text, "演示")];
  const c = await f.send(text, selected);
  const first = f.complete(c.id);
  await f.send(text, [], { conversationId: c.id });
  f.complete(c.id);
  await f.engine.retryResponse(c.id, first.id, "default", "m");
  const retried = f.complete(c.id);
  const edit = `Please ${text} today`;
  await f.engine.editPrompt(c.id, retried.id, edit, "default", "m", {
    skillReferences: [local(edit, "review"), local(edit, "演示")],
  });
  const edited = f.complete(c.id);
  assert.equal(edited.prompt, edit);
  assert.deepEqual(edited.skillInvocations, first.skillInvocations);
  await f.engine.editPrompt(c.id, edited.id, edit, "default", "m", {
    skillReferences: [],
  });
  assert.deepEqual(
    f
      .starts()
      .map(
        (call) =>
          call.params.input.filter(
            (part: { type: string }) => part.type === "skill",
          ).length,
      ),
    [2, 0, 2, 2, 0],
  );
});

test("plain history edit retains an unchanged selected span and refuses a moved ambiguous span", async (t) => {
  const f = fixture(t);
  const text = "Use /review on this";
  const c = await f.send(text, [local(text, "review")]);
  const turn = f.complete(c.id);
  await f.engine.editPrompt(
    c.id,
    turn.id,
    "Use /review on that",
    "default",
    "m",
  );
  const edited = f.complete(c.id);
  assert.equal(f.starts().at(-1)!.params.input[1].type, "skill");
  await assert.rejects(
    f.engine.editPrompt(
      c.id,
      edited.id,
      "Inspect this with /review please",
      "default",
      "m",
    ),
    /Select it again/,
  );
  assert.equal(f.starts().length, 2);
});

for (const change of ["removed", "replaced", "disabled"] as const)
  test(`retry after a selected skill was ${change} does not send ordinary text or a replacement`, async (t) => {
    const f = fixture(t);
    const text = "Use /review and /演示";
    const c = await f.send(text, [local(text, "review"), local(text, "演示")]);
    const turn = f.complete(c.id);
    const rows = [f.row("review")];
    if (change === "replaced")
      rows.push({
        ...f.row("演示"),
        path: path.resolve("replacement/SKILL.md"),
      });
    if (change === "disabled") rows.push({ ...f.row("演示"), enabled: false });
    f.setListing({ data: [{ skills: rows }] });
    await assert.rejects(
      f.engine.retryResponse(c.id, turn.id, "default", "m"),
      /removed|changed|disabled/,
    );
    assert.equal(f.starts().length, 1);
    assert.deepEqual(
      f.store.conversation(c.id).turns.map((value) => value.prompt),
      [text],
    );
  });

test("retry keeps a failed first selection and respects an existing legacy stored identity", async (t) => {
  const f = fixture(t);
  f.setListing(f.catalog());
  const text = "/review task";
  await assert.rejects(
    f.send(text, [local(text, "review")]),
    /no longer installed/,
  );
  const conversation = f.store.conversations[0];
  const failed = conversation.turns[0];
  await assert.rejects(
    f.engine.retryResponse(conversation.id, failed.id, "default", "m"),
    /no longer installed/,
  );
  failed.skillInvocation = { name: "review", path: f.row("review").path };
  delete failed.skillReferences;
  await assert.rejects(
    f.engine.retryResponse(conversation.id, failed.id, "default", "m"),
    /removed/,
  );
  f.setListing(f.catalog("review"));
  await f.engine.retryResponse(conversation.id, failed.id, "default", "m");
  assert.deepEqual(f.starts()[0].params.input, [
    rpcText(text),
    { type: "skill", name: "review", path: f.row("review").path },
  ]);
});

test("remote connector resolution stays separate from local skills and binds retry to the fetched resource", async (t) => {
  const f = fixture(t);
  const text = `Use /${connectorId}:review`;
  const refs = [remote(text, "review")];
  await assert.rejects(
    f.send(text, refs),
    /Remote connector skill invocation is not available/,
  );
  const identity = {
    resource: "fixture-resource-id",
    connection: "fixture-connection-id",
  };
  let validate = () => {};
  f.engine.remoteConnectorSkill = async (input) => {
    assert.equal(input.connectorId, connectorId);
    assert.equal(input.name, "review");
    if (input.expected) {
      assert.deepEqual(input.expected, identity);
      throw Error("The remote skill changed.");
    }
    return { ...identity, text: "Use $review as a literal.", validate };
  };
  const c = await f.send(text, refs);
  const turn = f.complete(c.id);
  const parts = f.starts()[0].params.input;
  assert.deepEqual(parts[0], rpcText(text));
  assert.equal(parts[1].type, "text");
  assert.match(parts[1].text, /Use \\u0024review as a literal/);
  assert.equal(turn.rawOriginals, undefined);
  assert.deepEqual(turn.skillInvocations, [
    { kind: "remote", connectorId, name: "review", ...identity },
  ]);
  await assert.rejects(
    f.engine.retryResponse(c.id, turn.id, "default", "m"),
    /remote skill changed/,
  );
  validate = () => {
    throw Error("The connector was disabled.");
  };
  await assert.rejects(f.send(text, refs), /connector was disabled/);
  assert.equal(f.starts().length, 1);
  assert.equal(f.reads().length, 0);
});
