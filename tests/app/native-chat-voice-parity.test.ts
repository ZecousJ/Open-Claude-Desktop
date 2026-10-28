import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as React from "react";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import ts from "typescript";
import { transform } from "sucrase";
import { build } from "esbuild";
import { desktopHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { CoworkVoiceControls } from "../../src/composer/voice/CoworkVoiceControls";
import { setLocale } from "../../src/i18n";
import { readSource } from "../support/read-source";

registerHooks({
  load(url, context, next) {
    if (url.includes("?url"))
      return {
        format: "module",
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { VoiceModeButton } = await import("../../src/composer/VoiceModeButton");

// Exercise the actual caller expressions: rendering the leaf component alone
// would miss a native-only omission or a Suspense fallback in Composer.
const source = readSource("src/composer/Composer.tsx");
const parsed = ts.createSourceFile(
  "Composer.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function caller(name: string, values: Record<string, unknown>) {
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name)
      expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(expression, `Composer still declares ${name}`);
  const code = transform(`return (${expression.getText(parsed)});`, {
    transforms: ["jsx", "typescript"],
    production: true,
  }).code;
  return new Function(...Object.keys(values), code)(...Object.values(values));
}
function renderCaller(
  name: "chatActions" | "chinVoice",
  {
    incognito = false,
    reason,
    pending = false,
    embedded = false,
    windowRole = "main",
  }: {
    incognito?: boolean;
    reason?: string;
    pending?: boolean;
    embedded?: boolean;
    windowRole?: "main" | "conversation" | "project";
  } = {},
) {
  const pendingVoice = React.lazy(
    () => new Promise<{ default: typeof VoiceModeButton }>(() => {}),
  );
  // Execute the production host/privacy predicates too. Supplying a
  // constant true would conceal a regression in the independent renderer
  // and conversation-window privacy branches.
  const host = desktopHost;
  const mode = "chat";
  const window = embedded ? { ClaudexConversation: {} } : {};
  const webSurface = caller("webSurface", { host, window });
  const webChat = caller("webChat", { webSurface, mode });
  const unifiedChat = caller("unifiedChat", { host, webSurface, mode });
  const incognitoControls = caller("incognitoControls", {
    incognito,
    unifiedChat,
    appContext: { windowRole: { kind: windowRole } },
    window,
  });
  const webReplyVoice = caller("webReplyVoice", {
    webChat,
    active: name === "chinVoice" ? {} : undefined,
    incognitoControls,
  });
  const node = caller(name, {
    React,
    Suspense: React.Suspense,
    CoworkVoiceControls,
    VoiceModeButton: pending ? pendingVoice : VoiceModeButton,
    SubmitPill: () => null,
    host,
    mode,
    webReplyVoice,
    running: false,
    sendShown: false,
    stopButton: null,
    sendButton: null,
    micButton: React.createElement("button", { "aria-label": "Dictate" }),
    incognito,
    incognitoControls,
    dictationReason: reason,
    voice: { transcription: true, maxSeconds: 90 },
    speechEngine: "service",
    setVoicePhase: () => {},
  });
  return parseHTML(
    renderToString(
      React.createElement(HostContext.Provider, { value: desktopHost }, node),
    ),
  ).document;
}
const labels = (document: Document) =>
  [...document.querySelectorAll("button")].map((e) =>
    e.getAttribute("aria-label"),
  );

test("native Chat home and conversation include microphone, options and separate voice", () => {
  for (const name of ["chatActions", "chinVoice"] as const) {
    const document = renderCaller(name);
    assert.deepEqual(labels(document), [
      "Dictate",
      "Microphone",
      "Use voice mode",
    ]);
    assert.ok(
      document.querySelector('.cowork-voice-options[aria-haspopup="menu"]'),
    );
    assert.equal(
      document.querySelector(".voice-mode-chevron"),
      null,
      "native uses the microphone's caret rather than duplicating one after voice mode",
    );
  }
});

test("native microphone options are visible on the first render while voice mode loads", () => {
  const document = renderCaller("chatActions", { pending: true });
  assert.deepEqual(labels(document), ["Dictate", "Microphone"]);
  assert.ok(
    document.querySelector(".cowork-voice-options [data-icon='CaretDown']"),
  );
  assert.ok(
    document.querySelector(
      '.composer-home-voice-placeholder[aria-hidden="true"]',
    ),
  );
  assert.equal(
    document.querySelector(".cowork-voice-options[aria-hidden]"),
    null,
  );
});

test("main native incognito keeps microphone options and the ordinary voice mode entry", () => {
  for (const name of ["chatActions", "chinVoice"] as const)
    assert.deepEqual(labels(renderCaller(name, { incognito: true })), [
      "Dictate",
      "Microphone",
      "Use voice mode",
    ]);
});

test("independent native incognito projections preserve their microphone-only privacy branch", () => {
  for (const projection of [
    { embedded: true },
    { windowRole: "conversation" as const },
    { windowRole: "project" as const },
  ])
    for (const name of ["chatActions", "chinVoice"] as const)
      assert.deepEqual(
        labels(renderCaller(name, { incognito: true, ...projection })),
        ["Dictate", "Microphone"],
      );
});

test("unavailable service keeps controls honestly disabled rather than enabling a fake voice path", () => {
  const document = renderCaller("chatActions", {
    reason: "Your administrator turned dictation off",
  });
  const caret = document.querySelector(".cowork-voice-options")!;
  assert.equal(caret.getAttribute("aria-disabled"), "true");
  assert.equal(caret.hasAttribute("aria-haspopup"), false);
  assert.equal(
    document.querySelector(".voice-mode-main")!.getAttribute("aria-disabled"),
    "true",
  );
});

test("toolbar caret does not eagerly import the voice recorder or speech engine", async () => {
  const result = await build({
    entryPoints: ["src/composer/voice/CoworkVoiceControls.tsx"],
    outdir: "/tmp/claudex-native-chat-voice-parity",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    write: false,
    metafile: true,
    external: ["react", "react-dom"],
    loader: { ".css": "empty", ".svg": "text" },
    logLevel: "silent",
  });
  const outputs = result.metafile!.outputs;
  const entry = Object.entries(outputs).find(
    ([, value]) =>
      value.entryPoint === "src/composer/voice/CoworkVoiceControls.tsx",
  )!;
  const visited = new Set<string>();
  const inputs = new Set<string>();
  function walk(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    for (const input of Object.keys(outputs[path].inputs)) inputs.add(input);
    for (const imported of outputs[path].imports)
      if (imported.kind === "import-statement" && outputs[imported.path])
        walk(imported.path);
  }
  walk(entry[0]);
  assert.ok(inputs.has("src/composer/voice/CoworkVoiceControls.tsx"));
  for (const path of [
    "src/composer/VoiceModeButton.tsx",
    "src/voice/useVoiceMode.ts",
    "src/composer/MicrophoneMenu.tsx",
  ])
    assert.equal(inputs.has(path), false, path);
  assert.ok(
    Object.values(outputs).some(
      (value) => "src/composer/MicrophoneMenu.tsx" in value.inputs,
    ),
    "the real device menu still has a lazy route",
  );
});

test("native microphone and voice accessible labels follow the selected locale", async () => {
  try {
    await setLocale("zh-CN");
    const document = parseHTML(
      renderToStaticMarkup(
        React.createElement(
          HostContext.Provider,
          { value: desktopHost },
          React.createElement(VoiceModeButton),
        ),
      ),
    ).document;
    assert.deepEqual(labels(document), ["使用语音模式", "麦克风"]);
  } finally {
    await setLocale("en-US");
  }
});
