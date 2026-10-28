import test from "node:test";
import assert from "node:assert/strict";
import {
  EngineExtensions,
  type DynamicToolCall,
  type EngineTurnContext,
} from "../../electron/engine/engine-extensions";
import {
  simulatorExtension,
  toolResult,
} from "../../electron/simulators/tools";
import {
  controlTool,
  simulatorNamespaces,
} from "../../electron/simulators/tool-schemas";
import {
  controlArguments,
  simulatorInstructions,
  simulatorToolSpecs,
} from "../../electron/simulators/tool-schemas";
import type { SimulatorService } from "../../electron/simulators/service";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import type { SimulatorKind } from "../../shared/simulators";
import { defaultSettings } from "../../electron/store/store";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "t",
    mode: "code",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    cwd: "/work",
    ...overrides,
  };
}

function context(overrides: Partial<Conversation> = {}): EngineTurnContext {
  const c = conversation(overrides);
  return {
    conversation: c,
    mode: c.mode,
    provider: defaultSettings.providers[0],
    model: "m",
    policy: openPolicy,
    settings: defaultSettings,
    sandbox: "workspace-write",
  };
}

function fakeService(ready: SimulatorKind[], off: SimulatorKind[] = []) {
  const calls: unknown[] = [];
  const service = {
    approveTools: async () => "granted",
    permissionMode: () => {},
    unavailable: (kind: SimulatorKind) =>
      off.includes(kind) ? "off" : undefined,
    ready: (kind: SimulatorKind) => ready.includes(kind),
    control: async (kind: SimulatorKind, id: string, args: unknown) => {
      calls.push([kind, id, args]);
      return { success: true, parts: [{ type: "text" as const, text: "ok" }] };
    },
    forget: (id: string) => calls.push(["forget", id]),
  } as unknown as SimulatorService;
  return { service, calls };
}

function registry(
  service: SimulatorService | undefined,
  unattended = (_id: string) => false,
) {
  const extensions = new EngineExtensions();
  extensions.add(simulatorExtension({ service: () => service, unattended }));
  return extensions;
}

const namespaces = (specs: ReturnType<EngineExtensions["dynamicTools"]>) =>
  specs.map((spec) => spec.name);

test("each kind has one namespace with the control tool", () => {
  const specs = simulatorToolSpecs(["ios", "android"]);
  assert.deepEqual(namespaces(specs), [
    "claudex_ios_simulator",
    "claudex_android_emulator",
  ]);
  for (const spec of specs) {
    assert.equal(spec.type, "namespace");
    if (spec.type !== "namespace") continue;
    assert.equal(spec.tools[0].name, controlTool);
    const schema = spec.tools[0].inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    assert.deepEqual(schema.required, ["action"]);
    assert.ok(schema.properties.action.enum?.includes("screenshot"));
    // No action the app can't do.
    assert.ok(!schema.properties.action.enum?.includes("inspect"));
    assert.ok(!schema.properties.action.enum?.includes("touch2_path"));
  }
  const ios = specs[0];
  const android = specs[1];
  if (ios.type === "namespace" && android.type === "namespace") {
    const buttons = (spec: typeof ios) =>
      (
        spec.tools[0].inputSchema as {
          properties: { name: { enum: string[] } };
        }
      ).properties.name.enum;
    assert.deepEqual(buttons(ios), [
      "HOME",
      "LOCK",
      "SIRI",
      "SIDE_BUTTON",
      "APPLE_PAY",
    ]);
    assert.ok(buttons(android).includes("BACK"));
  }
});

test("the tools are offered in Code on this computer, for the kinds that are ready and on", () => {
  const { service } = fakeService(["ios", "android"], ["android"]);
  const extensions = registry(service);
  assert.deepEqual(namespaces(extensions.dynamicTools(context())), [
    "claudex_ios_simulator",
  ]);
  assert.deepEqual(extensions.developerInstructions(context()), [
    simulatorInstructions,
  ]);

  // Not ready (setup incomplete): nothing.
  assert.deepEqual(
    registry(fakeService([]).service).dynamicTools(context()),
    [],
  );
  // Chat, Cowork, a computer over SSH, a routine's run, no service: nothing.
  assert.deepEqual(extensions.dynamicTools(context({ mode: "chat" })), []);
  assert.deepEqual(extensions.dynamicTools(context({ mode: "cowork" })), []);
  assert.deepEqual(
    extensions.dynamicTools(
      context({ environment: { kind: "ssh", hostId: "h" } as never }),
    ),
    [],
  );
  assert.deepEqual(registry(service, () => true).dynamicTools(context()), []);
  assert.deepEqual(registry(undefined).dynamicTools(context()), []);
  // An incognito conversation gets nothing.
  assert.deepEqual(extensions.dynamicTools(context({ incognito: true })), []);
});

function call(overrides: Partial<DynamicToolCall> = {}): DynamicToolCall {
  return {
    conversation: conversation(),
    threadId: "t",
    turnId: "u",
    callId: "k",
    namespace: simulatorNamespaces.ios,
    tool: controlTool,
    arguments: {
      action: "screenshot",
      udid: "33333333-3333-3333-3333-333333333333",
    },
    changed() {},
    ...overrides,
  };
}

test("a call reaches the service with its arguments checked", async () => {
  const { service, calls } = fakeService(["ios"]);
  const result = await registry(service).handleDynamicTool(call());
  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    [
      "ios",
      "c1",
      { action: "screenshot", device: "33333333-3333-3333-3333-333333333333" },
    ],
  ]);

  const bad = await registry(service).handleDynamicTool(
    call({ arguments: { action: 5 } }),
  );
  assert.equal(bad.success, false);
  assert.match(
    String((bad.contentItems[0] as { text: string }).text),
    /Invalid arguments/,
  );
  const both = await registry(service).handleDynamicTool(
    call({ arguments: { action: "attach", device: "a", serial: "b" } }),
  );
  assert.match(
    String((both.contentItems[0] as { text: string }).text),
    /at most one/,
  );
  const extra = controlArguments({ action: "tap", x: 1, y: 2, shell: "rm" });
  assert.ok("error" in extra);
});

test("a call from where the tools don't apply is refused, and other tools are not claimed", async () => {
  const { service, calls } = fakeService(["ios"]);
  const extensions = registry(service);
  const chat = await extensions.handleDynamicTool(
    call({ conversation: conversation({ mode: "chat" }) }),
  );
  assert.equal(chat.success, false);
  const routine = await registry(service, () => true).handleDynamicTool(call());
  assert.equal(routine.success, false);
  assert.deepEqual(calls, []);
  const other = await extensions.handleDynamicTool(
    call({ namespace: "claudex_memory", tool: "memory_edits" }),
  );
  assert.match(
    String((other.contentItems[0] as { text: string }).text),
    /isn't available/,
  );
});

test("pictures leave as data URLs", () => {
  const result = toolResult({
    success: true,
    parts: [
      {
        type: "image",
        image: {
          data: Buffer.from("abc"),
          mimeType: "image/jpeg",
          width: 1,
          height: 1,
        },
      },
      { type: "text", text: "Screenshot: 1x1" },
    ],
  });
  assert.deepEqual(result.contentItems, [
    { type: "inputImage", imageUrl: "data:image/jpeg;base64,YWJj" },
    { type: "inputText", text: "Screenshot: 1x1" },
  ]);
});
