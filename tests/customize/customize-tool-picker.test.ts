import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h } from "react";
import {
  conversationDisabledTools,
  conversationToolEnabled,
  conversationToolPatch,
  mergeConversationToolOverrides,
  type ConversationToolCatalog,
  type ConversationToolOverrides,
} from "../../shared/conversation-tools";
import {
  ConversationToolPicker,
  type ConversationToolPickerProps,
} from "../../src/connectors/ConversationToolPicker";
import { routineDom } from "../support/routine-dom";

const catalog: ConversationToolCatalog = [
  {
    name: "alpha",
    displayName: "Settings {literal}",
    available: true,
    disabledTools: ["locked", "old-global-entry"],
    tools: [
      { name: "read", description: "Actual read tool" },
      { name: "write" },
      { name: "locked" },
      {
        name: "policy",
        blocked: true,
        blockedReason: "Restricted by the actual host",
      },
    ],
  },
  {
    name: "beta",
    displayName: "Offline service",
    available: false,
    unavailableReason: "The host has not authenticated this connector",
    disabledTools: [],
    tools: [{ name: "read" }],
  },
];
const overrides: ConversationToolOverrides = {
  alpha: { read: true, write: false, locked: true },
  beta: { read: true },
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(extra: Partial<ConversationToolPickerProps> = {}) {
  const env = await routineDom({}, { jsdom: true });
  const calls: ConversationToolOverrides[] = [];
  let closes = 0;
  const authority = { live: true };
  const props: ConversationToolPickerProps = {
    catalog,
    overrides,
    owner: {},
    current: () => authority.live,
    onSave: async (patch) => {
      calls.push(patch);
    },
    onClose: () => {
      closes++;
    },
    ...extra,
  };
  const render = (next: Partial<ConversationToolPickerProps> = {}) => {
    Object.assign(props, next);
    return env.render(h(ConversationToolPicker, { ...props }));
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const found = env.document.querySelector<T>(selector);
    assert.ok(found, selector);
    return found;
  };
  const open = () => env.click('[aria-label="Customize Settings {literal}"]');
  return {
    ...env,
    rawRender: env.render,
    props,
    authority,
    calls,
    render,
    query,
    open,
    closes: () => closes,
  };
}

test("effective tool state and sparse patches preserve global blocks, policy and unrelated connectors", () => {
  const server = catalog[0];
  assert.equal(
    conversationToolEnabled(server, server.tools[0], overrides),
    true,
  );
  assert.equal(
    conversationToolEnabled(server, server.tools[1], overrides),
    false,
  );
  assert.equal(
    conversationToolEnabled(server, server.tools[2], overrides),
    false,
  );
  assert.equal(
    conversationToolEnabled(server, server.tools[3], overrides),
    false,
  );
  assert.deepEqual(
    conversationToolPatch(
      server,
      ["read", "write", "locked", "policy", "unknown"],
      true,
      overrides,
    ),
    { alpha: { write: true } },
  );
  assert.deepEqual(
    conversationToolPatch(catalog[1], ["read"], true, overrides),
    {},
  );
  assert.deepEqual(conversationDisabledTools(server, overrides), [
    "locked",
    "old-global-entry",
    "write",
    "policy",
  ]);
  assert.deepEqual(
    mergeConversationToolOverrides(overrides, { alpha: { read: false } }),
    {
      alpha: { read: false, write: false, locked: true },
      beta: { read: true },
    },
  );
  assert.deepEqual(overrides, {
    alpha: { read: true, write: false, locked: true },
    beta: { read: true },
  });
});

test("actual connector selection retains named switches, tool counts, Customize and Continue without invented auth actions", async (t) => {
  const env = await setup();
  t.after(env.clean);
  await env.render();
  assert.equal(
    env.query('[role="dialog"]').getAttribute("aria-label"),
    "Allow access to connectors and tools",
  );
  assert.equal(
    env.document.querySelector(
      '[role="switch"][aria-label="Settings {literal}"]',
    ),
    null,
    "a partial selection is a count pill, not an all-enabled switch",
  );
  assert.match(
    env.query('[aria-label="Customize Settings {literal}"]').textContent!,
    /1 of 4/,
  );
  assert.equal(
    env.query<HTMLButtonElement>(
      '[role="switch"][aria-label="Offline service"]',
    ).disabled,
    true,
  );
  assert.match(env.document.body.textContent!, /host has not authenticated/);
  assert.equal(
    [...env.document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Connect",
    ),
    false,
  );
  const done = [...env.document.querySelectorAll("button")].find(
    (button) => button.textContent === "Continue",
  );
  assert.ok(done);
  await env.event(done, "click");
  assert.equal(env.closes(), 1);
  assert.equal(env.document.querySelector('[role="dialog"]'), null);
});

test("actual any-enabled bulk switch toggles every eligible tool atomically even while search hides them", async (t) => {
  const env = await setup();
  t.after(env.clean);
  await env.render();
  await env.open();
  assert.equal(env.query("h2").textContent, "Customize Settings {literal}");
  assert.match(
    env.query(".conversation-tool-all").textContent!,
    /Disable all tools/,
  );
  await env.change('input[type="search"]', "WRITE");
  assert.equal(
    env.document.querySelectorAll(".conversation-tool-option").length,
    1,
  );
  await env.click(".conversation-tool-all");
  assert.deepEqual(
    env.calls,
    [{ alpha: { read: false } }],
    "one sparse patch, including the hidden enabled tool",
  );
  assert.match(
    env.query(".conversation-tool-all").textContent!,
    /Enable all tools/,
  );
  await env.click(".conversation-tool-all");
  assert.deepEqual(env.calls[1], { alpha: { read: true, write: true } });
  assert.equal(env.calls.length, 2);
  await env.change('input[type="search"]', "");
  for (const name of ["read", "write"])
    assert.equal(
      env
        .query(`[role="switch"][aria-label="${name}"]`)
        .getAttribute("aria-checked"),
      "true",
    );
  for (const name of ["locked", "policy"]) {
    assert.equal(
      env.query<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)
        .disabled,
      true,
    );
    assert.equal(
      env
        .query(`[role="switch"][aria-label="${name}"]`)
        .getAttribute("aria-checked"),
      "false",
    );
  }
});

test("a real per-tool click changes only its availability and keeps the detail dialog open", async (t) => {
  const env = await setup();
  t.after(env.clean);
  await env.render();
  await env.open();
  await env.click('[role="switch"][aria-label="write"]');
  assert.deepEqual(env.calls, [{ alpha: { write: true } }]);
  assert.equal(
    env
      .query('[role="switch"][aria-label="write"]')
      .getAttribute("aria-checked"),
    "true",
  );
  assert.ok(env.document.querySelector('[role="dialog"]'));
  assert.equal(
    env
      .query('[role="switch"][aria-label="locked"]')
      .getAttribute("aria-checked"),
    "false",
  );
  assert.match(env.document.body.textContent!, /Restricted by the actual host/);
});

test("pending save neither paints success nor accepts duplicate mutations; acknowledgement applies once", async (t) => {
  const pending = deferred<void>();
  let writes = 0;
  const env = await setup({
    onSave: async () => {
      writes++;
      await pending.promise;
    },
  });
  t.after(env.clean);
  await env.render();
  await env.open();
  await env.click('[role="switch"][aria-label="read"]');
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    env.query(".conversation-tool-picker-body").getAttribute("aria-busy"),
    "true",
  );
  assert.equal(
    env.query<HTMLButtonElement>(".conversation-tool-all").disabled,
    true,
  );
  await env.click('[role="switch"][aria-label="read"]');
  assert.equal(writes, 1);
  await act(async () => pending.resolve());
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    env.query(".conversation-tool-picker-body").getAttribute("aria-busy"),
    "false",
  );
});

test("failure preserves the previous state and Retry submits one new atomic patch without exposing backend text", async (t) => {
  const calls: ConversationToolOverrides[] = [];
  const env = await setup({
    onSave: async (patch) => {
      calls.push(patch);
      if (calls.length === 1) throw new Error("private transport token");
    },
  });
  t.after(env.clean);
  await env.render();
  await env.open();
  await env.click('[role="switch"][aria-label="read"]');
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "true",
  );
  assert.match(
    env.query('[role="alert"]').textContent!,
    /Couldn’t save your change/,
  );
  assert.doesNotMatch(
    env.document.body.textContent!,
    /private transport token/,
  );
  await env.click('[role="alert"] button');
  assert.deepEqual(calls, [
    { alpha: { read: false } },
    { alpha: { read: false } },
  ]);
  assert.equal(env.document.querySelector('[role="alert"]'), null);
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "false",
  );
});

for (const retirement of ["owner", "current", "close", "unmount"] as const)
  test(`late save failure cannot affect the current dialog after ${retirement} retirement`, async (t) => {
    const pending = deferred<void>();
    const env = await setup({ onSave: () => pending.promise });
    t.after(env.clean);
    await env.render();
    await env.open();
    await env.click('[role="switch"][aria-label="read"]');
    if (retirement === "owner")
      await env.render({ owner: {}, catalog: [], overrides: {} });
    if (retirement === "current") {
      env.authority.live = false;
      await env.render();
    }
    if (retirement === "close")
      await env.event(env.document, "keydown", { key: "Escape" });
    if (retirement === "unmount")
      await env.rawRender(h("div", null, "Replacement route"));
    await act(async () => pending.reject(new Error("old account failure")));
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(env.document.body.textContent!, /old account failure/);
    if (retirement === "owner")
      assert.doesNotMatch(
        env.document.body.textContent!,
        /Settings \{literal\}/,
      );
  });

test("a retired current lease refuses a retained visible control before saving", async (t) => {
  const env = await setup();
  t.after(env.clean);
  await env.render();
  await env.open();
  env.authority.live = false;
  await env.click('[role="switch"][aria-label="read"]');
  assert.deepEqual(env.calls, []);
});

test("a newer authoritative override/baseline update wins over an older acknowledgement", async (t) => {
  const pending = deferred<void>();
  const env = await setup({ onSave: () => pending.promise });
  t.after(env.clean);
  await env.render();
  await env.open();
  await env.click('[role="switch"][aria-label="read"]');
  await env.render({
    overrides: { alpha: { read: true, write: true } },
    catalog: [
      { ...catalog[0], disabledTools: ["write", "locked"] },
      catalog[1],
    ],
  });
  await act(async () => pending.resolve());
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    env
      .query('[role="switch"][aria-label="write"]')
      .getAttribute("aria-checked"),
    "false",
  );
});

test("tool search reports the literal query and a single-tool connector has no bulk switch", async (t) => {
  const env = await setup({
    catalog: [{ ...catalog[0], tools: [{ name: "read" }] }],
  });
  t.after(env.clean);
  await env.render();
  await env.open();
  assert.equal(env.document.querySelector(".conversation-tool-all"), null);
  await env.change('input[type="search"]', "Settings {search}");
  assert.equal(
    env.query(".conversation-tool-empty").textContent,
    "No tools matching “Settings {search}”",
  );
  await env.click('[aria-label="Back"]');
  assert.ok(
    env.document.querySelector(
      '[aria-label="Allow access to connectors and tools"]',
    ),
  );
});

test("the visible connector switch batches its eligible tools without changing another connector", async (t) => {
  const env = await setup({
    overrides: { alpha: { read: false, write: false } },
  });
  t.after(env.clean);
  await env.render();
  await env.click('[role="switch"][aria-label="Settings {literal}"]');
  assert.deepEqual(env.calls, [{ alpha: { read: true, write: true } }]);
  assert.equal(
    env.query('[role="dialog"]').getAttribute("aria-label"),
    "Allow access to connectors and tools",
    "the switch does not also open the row",
  );
  assert.match(env.query(".conversation-tool-count").textContent!, /2 of 4/);
  assert.equal(
    env
      .query('[role="switch"][aria-label="Offline service"]')
      .getAttribute("aria-checked"),
    "false",
  );
});

test("a late successful old-owner save neither changes the new owner nor releases its pending operation", async (t) => {
  const oldSave = deferred<void>(),
    newSave = deferred<void>();
  const env = await setup({ onSave: () => oldSave.promise });
  t.after(env.clean);
  await env.render();
  await env.open();
  await env.click('[role="switch"][aria-label="read"]');
  await env.render({
    owner: {},
    overrides: { alpha: { read: true, write: false } },
    onSave: () => newSave.promise,
  });
  await env.open();
  await env.click('[role="switch"][aria-label="write"]');
  await act(async () => oldSave.resolve());
  assert.equal(
    env.query(".conversation-tool-picker-body").getAttribute("aria-busy"),
    "true",
  );
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    env
      .query('[role="switch"][aria-label="write"]')
      .getAttribute("aria-checked"),
    "false",
  );
  await act(async () => newSave.resolve());
  assert.equal(
    env
      .query('[role="switch"][aria-label="write"]')
      .getAttribute("aria-checked"),
    "true",
  );
});

test("Retry rechecks a changed global baseline and cannot lift the new restriction", async (t) => {
  let calls = 0;
  const env = await setup({
    onSave: async () => {
      calls++;
      throw new Error("refused");
    },
  });
  t.after(env.clean);
  await env.render();
  await env.open();
  await env.click('[role="switch"][aria-label="read"]');
  await env.render({
    catalog: [
      { ...catalog[0], disabledTools: [...catalog[0].disabledTools, "read"] },
      catalog[1],
    ],
  });
  await env.click('[role="alert"] button');
  assert.equal(calls, 1);
  assert.equal(env.document.querySelector('[role="alert"]'), null);
  assert.equal(
    env.query<HTMLButtonElement>('[role="switch"][aria-label="read"]').disabled,
    true,
  );
  assert.equal(
    env
      .query('[role="switch"][aria-label="read"]')
      .getAttribute("aria-checked"),
    "false",
  );
});
