import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComputerUseBroker,
  type BrokerConversation,
  type BrokerDeps,
} from "../../electron/computer-use/broker";
import type { DriverApp } from "../../electron/computer-use/driver-host";
import { ScreenshotStore } from "../../electron/computer-use/screenshots";
import type {
  ComputerUseAccessRequest,
  ComputerUseActivity,
  ComputerUseSettings,
  ComputerUseToolResult,
} from "../../shared/computer-use";
import type { ComputerUsePolicy } from "../../shared/client-policy";

interface Harness {
  broker: ComputerUseBroker;
  calls: { tool: string; args: Record<string, unknown>; mode: string }[];
  requests: ComputerUseAccessRequest[];
  resolved: string[];
  activity: (ComputerUseActivity | null)[];
  control: string[];
  policy: ComputerUsePolicy;
  settings: ComputerUseSettings;
  conversation: BrokerConversation;
  permissions: { ready: boolean };
  opened: string[];
  clipboard: { text: string };
  call(
    tool: string,
    args?: Record<string, unknown>,
    conversationId?: string,
  ): Promise<ComputerUseToolResult>;
}

const apps: DriverApp[] = [
  {
    name: "TextEdit",
    id: "com.apple.TextEdit",
    running: true,
    frontmost: true,
  },
  { name: "Safari", id: "com.apple.Safari", running: true, frontmost: false },
  {
    name: "Terminal",
    id: "com.apple.Terminal",
    running: true,
    frontmost: false,
  },
  {
    name: "1Password",
    id: "com.1password.1password",
    running: true,
    frontmost: false,
  },
  { name: "Notes", id: "com.apple.Notes", running: false, frontmost: false },
];

function harness(overrides: Partial<BrokerDeps> = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cu-broker-"));
  const h = {
    calls: [],
    requests: [],
    resolved: [],
    activity: [],
    control: [],
    opened: [],
    clipboard: { text: "before" },
    policy: {
      enabled: true,
      allowFullControl: true,
      deniedApps: [],
      maxActionsPerTurn: null,
    },
    settings: {
      enabled: true,
      mode: "background",
      unhideApps: true,
      deniedApps: [],
    },
    conversation: {
      mode: "cowork",
      incognito: false,
      running: true,
      turnId: "t1",
      remote: false,
      unattended: false,
    },
    permissions: { ready: true },
  } as unknown as Harness;
  const deps: BrokerDeps = {
    platform: "darwin",
    policy: () => h.policy,
    settings: () => h.settings,
    driverInstalled: () => true,
    permissionsReady: () => h.permissions.ready,
    conversation: (id) =>
      id === "c1" || id === "c2" ? h.conversation : undefined,
    driver: {
      listApps: async () => apps,
      call: async (tool, args, mode) => {
        h.calls.push({ tool, args, mode });
        if (tool === "get_app_state")
          return {
            content: [
              { type: "text", text: "0 window TextEdit\n1 button Save" },
              {
                type: "image",
                data: Buffer.from("PNGDATA").toString("base64"),
                mimeType: "image/png",
              },
            ],
          };
        return { content: [{ type: "text", text: `${tool} done` }] };
      },
      stop: async () => {},
    },
    screenshots: new ScreenshotStore(root, (data) => ({
      data: Buffer.concat([Buffer.from("JPEG:"), data]),
      mimeType: "image/jpeg",
      width: 1000,
      height: 500,
      sourceWidth: 2000,
      sourceHeight: 1000,
    })),
    installedApps: async () => [
      {
        id: "com.apple.Notes",
        name: "Notes",
        platform: "darwin",
        path: "/Applications/Notes.app",
      },
    ],
    openApp: async (app) => {
      h.opened.push(app.id);
    },
    emit: {
      request: (request) => h.requests.push(request),
      resolved: (id) => h.resolved.push(id),
      activity: (activity) => h.activity.push(activity),
    },
    fullControl: {
      begin: async (_conversationId, keep) => {
        h.control.push(`begin:${keep.map((app) => app.id).join(",")}`);
      },
      update: (name) => h.control.push(`update:${name}`),
      end: async (unhide) => {
        h.control.push(`end:${unhide}`);
      },
    },
    clipboard: {
      read: () => h.clipboard.text,
      write: (text) => {
        h.clipboard.text = text;
      },
    },
    accessTimeoutMs: 200,
    ...overrides,
  };
  h.broker = new ComputerUseBroker(deps);
  h.call = (tool, args = {}, conversationId = "c1") =>
    h.broker.handle(conversationId, { type: "call", id: 1, tool, args });
  return h;
}

const textOf = (result: ComputerUseToolResult) =>
  result.content
    .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
    .join("\n");

/** Answers the next access request with `allow` (ids) or "deny". */
async function answerNext(h: Harness, allow: string[] | "deny") {
  for (let i = 0; i < 50 && !h.requests.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const request = h.requests.shift();
  assert.ok(request, "an access request was sent");
  h.broker.answer(request.id, allow === "deny" ? "deny" : { allow, deny: [] });
  return request;
}

async function grant(h: Harness, apps: string[], ids = apps) {
  const pending = h.call("request_access", { apps, reason: "Edit the draft" });
  await answerNext(h, ids);
  return pending;
}

test("activity preview captures only the active conversation's granted app", async () => {
  const h = harness();
  assert.equal(await h.broker.preview("c1"), null);
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  await h.call("get_app_state", { app: "TextEdit" });
  const count = h.calls.length;
  assert.equal(await h.broker.preview("c2"), null);
  assert.equal(h.calls.length, count);
  assert.equal(
    await h.broker.preview("c1"),
    `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`,
  );
  assert.deepEqual(h.calls.at(-1), {
    tool: "get_app_state",
    args: { app: "com.apple.TextEdit", max_tree_nodes: 1, max_tree_depth: 1 },
    mode: "background",
  });
  h.permissions.ready = false;
  assert.equal(await h.broker.preview("c1"), null);
  h.permissions.ready = true;
  h.settings.deniedApps = [
    { id: "com.apple.TextEdit", name: "TextEdit", platform: "darwin" },
  ];
  assert.equal(await h.broker.preview("c1"), null);
  h.settings.deniedApps = [];
  h.conversation.running = false;
  assert.equal(await h.broker.preview("c1"), null);
  h.conversation.running = true;
  await h.broker.stop("c1");
  assert.equal(await h.broker.preview("c1"), null);
  await h.broker.dispose();
});

test("a capture completing after Stop never reaches the renderer", async () => {
  let complete: ((value: ComputerUseToolResult) => void) | undefined;
  let capturing: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    capturing = resolve;
  });
  const h = harness({
    driver: {
      listApps: async () => apps,
      call: async (_tool, args) => {
        if (args.max_tree_nodes === 1) {
          capturing?.();
          return new Promise<ComputerUseToolResult>((resolve) => {
            complete = resolve;
          });
        }
        return { content: [] };
      },
      stop: async () => {},
    },
  });
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  await h.call("get_app_state", { app: "TextEdit" });
  const pending = h.broker.preview("c1");
  await started;
  await h.broker.stop("c1");
  complete?.({
    content: [{ type: "image", mimeType: "image/png", data: "UE5H" }],
  });
  assert.equal(await pending, null);
  await h.broker.dispose();
});

test("every layer can turn computer use off", async () => {
  const h = harness();
  h.policy.enabled = false;
  assert.match(textOf(await h.call("list_apps")), /administrator/);
  h.policy.enabled = true;
  h.settings.enabled = false;
  assert.match(textOf(await h.call("list_apps")), /turned off in Settings/);
  h.settings.enabled = true;
  h.conversation.mode = "chat";
  assert.match(textOf(await h.call("list_apps")), /Code and Cowork/);
  h.conversation.mode = "code";
  h.conversation.remote = true;
  assert.match(textOf(await h.call("list_apps")), /this computer/);
  h.conversation.remote = false;
  h.conversation.unattended = true;
  assert.match(textOf(await h.call("list_apps")), /Routines/);
  h.conversation.unattended = false;
  h.permissions.ready = false;
  assert.match(textOf(await h.call("list_apps")), /Accessibility/);
  h.permissions.ready = true;
  h.conversation.running = false;
  assert.match(textOf(await h.call("list_apps")), /working on a reply/);
  h.conversation.running = true;
  assert.equal((await h.call("list_apps", {}, "unknown")).isError, true);
  const ok = await h.call("list_apps");
  assert.equal(ok.isError, undefined);
  assert.match(
    textOf(ok),
    /TextEdit — com.apple.TextEdit \[running, frontmost, not granted\]/,
  );
  assert.match(textOf(ok), /1Password — .*not available/);
  assert.equal(h.broker.enabledFor("c1"), true);
});

test("nothing acts on an app before the person grants it", async () => {
  const h = harness();
  const result = await h.call("click", { app: "TextEdit", element_index: "1" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /not granted.*request_access/);
  assert.equal(h.calls.length, 0);
});

test("access requests list the apps with tiers; only allowed apps are granted", async () => {
  const h = harness();
  const pending = h.call("request_access", {
    apps: ["TextEdit", "Safari", "com.apple.Terminal", "1Password", "Nope"],
    reason: "Compare the page with the draft",
  });
  const request = await answerNext(h, [
    "com.apple.TextEdit",
    "com.apple.Terminal",
  ]);
  assert.equal(request.kind, "apps");
  assert.equal(request.reason, "Compare the page with the draft");
  assert.deepEqual(
    request.apps.map((item) => [item.app.id, item.tier]),
    [
      ["com.apple.TextEdit", "full"],
      ["com.apple.Safari", "read"],
      ["com.apple.Terminal", "click"],
    ],
  );
  assert.deepEqual(
    request.deniedAutomatically?.map((app) => app.id),
    ["com.1password.1password"],
  );
  const out = textOf(await pending);
  assert.match(out, /TextEdit: granted \(full access\)/);
  assert.match(out, /Terminal: granted \(click-only\)/);
  assert.match(out, /Safari: the person didn't allow it/);
  assert.match(out, /1Password: never available/);
  assert.match(out, /Nope: not found/);
  assert.deepEqual(h.resolved, [request.id]);
  assert.match(
    textOf(await h.call("list_granted_applications")),
    /TextEdit.*full access\)\nTerminal.*click-only/,
  );
  // Grants belong to the conversation.
  assert.match(
    textOf(
      await h.call("click", { app: "TextEdit", element_index: "1" }, "c2"),
    ),
    /not granted/,
  );
});

test("an unanswered request is denied after the timeout, and a denial grants nothing", async () => {
  const h = harness();
  const timedOut = await h.call("request_access", {
    apps: ["TextEdit"],
    reason: "x",
  });
  assert.match(textOf(timedOut), /didn't allow/);
  assert.equal(h.resolved.length, 1);
  const denied = h.call("request_access", { apps: ["TextEdit"], reason: "x" });
  h.requests.length = 0;
  await answerNext(h, "deny");
  assert.match(textOf(await denied), /didn't allow/);
  assert.match(
    textOf(await h.call("screenshot", { app: "TextEdit" })),
    /not granted/,
  );
});

test("answers can only allow apps that were asked for", async () => {
  const h = harness();
  const pending = h.call("request_access", { apps: ["TextEdit"], reason: "x" });
  for (let i = 0; i < 50 && !h.requests.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  h.broker.answer(h.requests[0].id, {
    allow: ["com.apple.TextEdit", "com.apple.Safari"],
    deny: [],
  });
  await pending;
  assert.match(textOf(await h.call("list_granted_applications")), /^TextEdit/);
  assert.doesNotMatch(
    textOf(await h.call("list_granted_applications")),
    /Safari/,
  );
  assert.throws(
    () => h.broker.answer(h.requests[0].id, "deny"),
    /already answered/,
  );
});

test("denied lists refuse without asking, and later denials revoke grants", async () => {
  const h = harness();
  h.policy.deniedApps = ["com.apple.textedit"];
  const out = textOf(
    await h.call("request_access", { apps: ["TextEdit"], reason: "x" }),
  );
  assert.match(out, /denied by the person or their administrator/);
  assert.equal(h.requests.length, 0);
  h.policy.deniedApps = [];
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  h.settings.deniedApps = [
    { id: "com.apple.TextEdit", name: "TextEdit", platform: "darwin" },
  ];
  assert.match(
    textOf(await h.call("click", { app: "TextEdit", element_index: "1" })),
    /denied/,
  );
  h.settings.deniedApps = [];
  assert.match(
    textOf(await h.call("click", { app: "TextEdit", element_index: "1" })),
    /not granted/,
  );
});

test("tiers: view-only apps can't be clicked, click-only apps can't be typed in", async () => {
  const h = harness();
  await grant(
    h,
    ["Safari", "Terminal", "TextEdit"],
    ["com.apple.Safari", "com.apple.Terminal", "com.apple.TextEdit"],
  );
  assert.match(
    textOf(await h.call("click", { app: "Safari", x: 1, y: 1 })),
    /view-only/,
  );
  assert.match(
    textOf(
      await h.call("scroll", {
        app: "Safari",
        element_index: "1",
        direction: "down",
      }),
    ),
    /view-only/,
  );
  assert.equal(
    (await h.call("screenshot", { app: "Safari" })).isError,
    undefined,
  );
  assert.equal(
    (await h.call("click", { app: "Terminal", element_index: "3" })).isError,
    undefined,
  );
  assert.equal(
    (
      await h.call("scroll", {
        app: "Terminal",
        element_index: "3",
        direction: "down",
      })
    ).isError,
    undefined,
  );
  for (const [tool, args] of [
    ["type_text", { text: "rm -rf ~" }],
    ["press_key", { key: "Return" }],
    ["click", { element_index: "3", mouse_button: "right" }],
    ["drag", { from_x: 1, from_y: 1, to_x: 2, to_y: 2 }],
    ["set_value", { element_index: "3", value: "x" }],
    ["perform_secondary_action", { element_index: "3", action: "AXShowMenu" }],
  ] as const)
    assert.match(
      textOf(await h.call(tool, { app: "Terminal", ...args })),
      /click-only/,
      tool,
    );
  const typed = await h.call("type_text", { app: "TextEdit", text: "hello" });
  assert.equal(typed.isError, undefined);
  const driverCalls = h.calls.map((call) => call.tool);
  assert.deepEqual(driverCalls, [
    "get_app_state",
    "click",
    "scroll",
    "type_text",
  ]);
  // The driver gets the exact bundle id, never the model's spelling.
  assert.equal(h.calls.at(-1)!.args.app, "com.apple.TextEdit");
  assert.equal(h.calls.at(-1)!.mode, "background");
});

test("input limits: long text, blocked keys", async () => {
  const h = harness();
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  assert.match(
    textOf(
      await h.call("type_text", { app: "TextEdit", text: "x".repeat(2001) }),
    ),
    /at most 2000/,
  );
  assert.match(
    textOf(
      await h.call("press_key", { app: "TextEdit", key: "cmd+option+esc" }),
    ),
    /whole computer/,
  );
  assert.equal(
    (await h.call("press_key", { app: "TextEdit", key: "super+s" })).isError,
    undefined,
  );
});

test("screenshots are kept, scaled for the model, and coordinates scaled back", async () => {
  const h = harness();
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  const shot = await h.call("get_app_state", { app: "TextEdit" });
  const image = shot.content.find((item) => item.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(Buffer.from(image.data, "base64").toString(), "JPEG:PNGDATA");
  const ref = shot.content.at(-1);
  assert.ok(
    ref?.type === "text" && ref.text.startsWith("claudex-screenshot://"),
  );
  assert.match(textOf(shot), /1 button Save/);
  // screenshot drops the accessibility tree.
  assert.doesNotMatch(
    textOf(await h.call("screenshot", { app: "TextEdit" })),
    /button Save/,
  );
  await h.call("click", { app: "TextEdit", x: 100, y: 50 });
  assert.equal(h.calls.at(-1)!.args.x, 200);
  assert.equal(h.calls.at(-1)!.args.y, 100);
  await h.call("drag", {
    app: "TextEdit",
    from_x: 1,
    from_y: 2,
    to_x: 3,
    to_y: 4,
  });
  assert.deepEqual(
    [h.calls.at(-1)!.args.from_x, h.calls.at(-1)!.args.to_y],
    [2, 8],
  );
});

test("the action cap per turn applies, lowered by policy, and resets each turn", async () => {
  const h = harness({ maxActionsPerTurn: 5 });
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  h.policy.maxActionsPerTurn = 3;
  // request_access was action 1 of this turn.
  assert.equal(
    (await h.call("screenshot", { app: "TextEdit" })).isError,
    undefined,
  );
  assert.equal(
    (await h.call("screenshot", { app: "TextEdit" })).isError,
    undefined,
  );
  assert.match(
    textOf(await h.call("screenshot", { app: "TextEdit" })),
    /limit of 3/,
  );
  h.conversation.turnId = "t2";
  assert.equal(
    (await h.call("screenshot", { app: "TextEdit" })).isError,
    undefined,
  );
});

test("stopping halts the rest of the turn; a new turn works again with the same grants", async () => {
  const h = harness();
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  await h.broker.stop("c1");
  assert.match(
    textOf(await h.call("screenshot", { app: "TextEdit" })),
    /stopped computer use/,
  );
  h.conversation.turnId = "t2";
  assert.equal(
    (await h.call("screenshot", { app: "TextEdit" })).isError,
    undefined,
  );
});

test("the end of a turn withdraws a waiting request", async () => {
  const h = harness({ accessTimeoutMs: 60_000 });
  const pending = h.call("request_access", { apps: ["TextEdit"], reason: "x" });
  for (let i = 0; i < 50 && !h.requests.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.broker.requests().length, 1);
  await h.broker.turnEnded("c1");
  assert.match(textOf(await pending), /didn't allow/);
  assert.equal(h.broker.requests().length, 0);
  assert.equal(h.resolved.length, 1);
});

test("full control: asks unless the setting says so, hides others, releases at turn end", async () => {
  const h = harness();
  assert.match(
    textOf(await h.call("request_full_control", { reason: "x" })),
    /Request access/,
  );
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  // Clipboard needs full control.
  assert.match(textOf(await h.call("read_clipboard")), /needs full control/);
  const asked = h.call("request_full_control", { reason: "Drag the file" });
  const card = await answerNext(h, "deny");
  assert.equal(card.kind, "full-control");
  assert.match(textOf(await asked), /didn't allow full control/);

  const again = h.call("request_full_control", { reason: "Drag the file" });
  await answerNext(h, []);
  assert.match(textOf(await again), /You have full control/);
  assert.deepEqual(h.control, ["begin:com.apple.TextEdit"]);
  assert.equal(h.activity.at(-1)?.mode, "fullControl");
  await h.call("click", { app: "TextEdit", element_index: "1" });
  assert.equal(h.calls.at(-1)!.mode, "fullControl");
  assert.equal((await h.call("read_clipboard")).content[0].type, "text");
  await h.call("write_clipboard", { text: "new" });
  assert.equal(h.clipboard.text, "new");
  // Another conversation can't act while this one has the screen.
  assert.match(
    textOf(await h.call("list_apps", {}, "c2")),
    /Another conversation/,
  );
  await h.broker.turnEnded("c1");
  assert.equal(h.control.at(-1), "end:true");
  assert.equal(h.activity.at(-1), null);
  h.conversation.turnId = "t2";
  await h.call("screenshot", { app: "TextEdit" });
  assert.equal(h.calls.at(-1)!.mode, "background");
});

test("full control with the Full control setting needs no card; the policy can forbid it", async () => {
  const h = harness();
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  h.settings.mode = "fullControl";
  assert.match(
    textOf(await h.call("request_full_control", { reason: "x" })),
    /You have full control/,
  );
  assert.equal(h.requests.length, 0);
  h.settings.unhideApps = false;
  assert.match(textOf(await h.call("release_full_control")), /Released/);
  assert.equal(h.control.at(-1), "end:false");
  h.policy.allowFullControl = false;
  assert.match(
    textOf(await h.call("request_full_control", { reason: "x" })),
    /doesn't allow full control/,
  );
});

test("losing the policy mid-way gives the screen back", async () => {
  const h = harness();
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  h.settings.mode = "fullControl";
  await h.call("request_full_control", { reason: "x" });
  h.policy.enabled = false;
  await h.broker.settingsChanged();
  assert.equal(h.control.at(-1), "end:true");
});

test("teaching waits for Next, refuses parallel actions, and Exit stops the turn", async () => {
  let answer: (value: "next" | "exit") => void = () => {};
  let hides = 0;
  const steps: unknown[] = [];
  const h = harness({
    teach: {
      show: (step) => {
        steps.push(step);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      hide: () => {
        hides++;
      },
    },
  });
  const step = {
    explanation: "Click Save",
    nextPreview: "Open the document",
    anchorLogical: { x: 100, y: 200 },
  };
  assert.equal((await h.call("teach_step", step)).isError, true);
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  h.settings.mode = "fullControl";
  await h.call("request_full_control", { reason: "Teach saving" });
  assert.equal(
    (
      await h.call("teach_step", {
        ...step,
        anchorLogical: { x: Infinity, y: 0 },
      })
    ).isError,
    true,
  );
  const waiting = h.call("teach_step", step);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, [step]);
  assert.match(
    textOf(await h.call("click", { app: "TextEdit", element_index: "1" })),
    /choose Next or Exit/,
  );
  answer("next");
  assert.match(textOf(await waiting), /perform the explained step/);
  const exiting = h.call("teach_step", step);
  await new Promise((resolve) => setImmediate(resolve));
  answer("exit");
  assert.match(textOf(await exiting), /exited teaching/);
  assert.ok(hides > 0);
  assert.equal(h.control.at(-1), "end:true");
  assert.match(
    textOf(await h.call("click", { app: "TextEdit", element_index: "1" })),
    /stopped computer use/,
  );
});

test("open_application needs a grant (view-only is enough) and opens in the background", async () => {
  const h = harness();
  assert.match(
    textOf(await h.call("open_application", { app: "Notes" })),
    /not granted/,
  );
  await grant(h, ["Notes", "Safari"], ["com.apple.Notes", "com.apple.Safari"]);
  assert.equal(
    (await h.call("open_application", { app: "Notes" })).isError,
    undefined,
  );
  assert.equal(
    (await h.call("open_application", { app: "Safari" })).isError,
    undefined,
  );
  assert.deepEqual(h.opened, ["com.apple.Notes", "com.apple.Safari"]);
});

test("Windows targets a running process by id, never by a title match", async () => {
  const winApps: DriverApp[] = [
    {
      name: "notepad",
      id: "notepad",
      pid: 4242,
      running: true,
      frontmost: false,
    },
    { name: "chrome", id: "chrome", pid: 7, running: true, frontmost: true },
  ];
  const h = harness({
    platform: "win32",
    driver: {
      listApps: async () => winApps,
      call: async (tool, args, mode) => {
        h.calls.push({ tool, args, mode });
        return { content: [{ type: "text", text: "ok" }] };
      },
      stop: async () => {},
    },
    installedApps: async () => [],
  });
  await grant(h, ["notepad.exe"], ["notepad"]);
  await h.call("type_text", { app: "notepad", text: "hi" });
  assert.equal(h.calls.at(-1)!.args.app, "4242");
  winApps.splice(0, 1);
  assert.match(
    textOf(await h.call("type_text", { app: "notepad", text: "hi" })),
    /isn't running/,
  );
});

test("dispose denies waiting requests and forgets grants", async () => {
  const h = harness({ accessTimeoutMs: 60_000 });
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  const pending = h.call("request_access", { apps: ["Notes"], reason: "x" });
  for (let i = 0; i < 50 && !h.requests.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await h.broker.dispose();
  assert.match(textOf(await pending), /didn't allow/);
  assert.match(
    textOf(await h.call("screenshot", { app: "TextEdit" })),
    /not granted/,
  );
});

test("an Esc the driver presses for the model isn't taken for the person's Stop", async () => {
  let now = 1000;
  let during: boolean | undefined;
  const h = harness({ now: () => now });
  const broker = () => h.broker;
  const inner = h.broker["deps"].driver.call;
  h.broker["deps"].driver.call = async (tool, args, mode) => {
    if (tool === "press_key") during = broker().pressingEscape();
    return inner(tool, args, mode);
  };
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  assert.equal(h.broker.pressingEscape(), false);
  await h.call("press_key", { app: "TextEdit", key: "esc" });
  assert.equal(during, true);
  // A short grace after the call for the key event to arrive.
  assert.equal(h.broker.pressingEscape(), true);
  now += 600;
  assert.equal(h.broker.pressingEscape(), false);
  // Other keys don't suppress the shortcut.
  await h.call("press_key", { app: "TextEdit", key: "Return" });
  assert.equal(during, false);
});

test("missing permissions: request_access shows the permissions card; the answer says whether they're granted", async () => {
  const h = harness();
  h.permissions.ready = false;
  assert.equal(h.broker.enabledFor("c1"), true, "the tools are still offered");
  assert.match(
    textOf(await h.call("get_app_state", { app: "TextEdit" })),
    /Call request_access/,
  );
  const first = h.call("request_access", { apps: ["TextEdit"], reason: "x" });
  const card = await answerNext(h, "deny");
  assert.equal(card.kind, "permissions");
  const denied = await first;
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /Don't call computer-use tools again/);
  const second = h.call("request_access", { apps: ["TextEdit"], reason: "x" });
  h.permissions.ready = true;
  await answerNext(h, "deny");
  assert.match(textOf(await second), /granted now\. Call request_access again/);
  await h.broker.dispose();
});

test("request_access can ask for the clipboard, which then works without full control", async () => {
  const h = harness();
  await grant(h, ["TextEdit"], ["com.apple.TextEdit"]);
  const asked = h.call("request_access", {
    apps: ["TextEdit"],
    reason: "Paste the summary",
    clipboard_write: true,
  });
  const card = await answerNext(h, []);
  assert.deepEqual(card.clipboard, { read: false, write: true });
  assert.equal(card.apps.length, 0, "TextEdit was already granted");
  assert.match(textOf(await asked), /Clipboard: granted \(write\)/);
  await h.call("write_clipboard", { text: "summary" });
  assert.equal(h.clipboard.text, "summary");
  assert.match(textOf(await h.call("read_clipboard")), /needs full control/);
  await h.broker.dispose();
});
