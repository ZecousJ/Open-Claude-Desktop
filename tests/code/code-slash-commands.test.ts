import test from "node:test";
import assert from "node:assert/strict";
import {
  autoResolveSlash,
  availableCodeSlashCommands,
  codeSlashCommands,
  filterCodeSlashCommands,
} from "../../src/composer/code/code-slash-commands";
import {
  executeCodeSlashCommand,
  resolveCodeSlashArgument,
} from "../../src/composer/code/code-slash-actions";
import { setLocale } from "../../src/i18n";

test("Code slash search preserves the original leading commands and selects model for /mo", () => {
  assert.deepEqual(
    codeSlashCommands.slice(0, 8).map((value) => value.name),
    ["schedule", "btw", "rewind", "fork", "mcp", "plugin", "feedback", "model"],
  );
  // With /goal, /loop, /resume and /copy; without /ultrareview (listed by the
  // live app only where a remote review session can be launched); /add-dir,
  // /review and /handoff are typed only.
  assert.equal(filterCodeSlashCommands("").length, 34);
  assert.equal(filterCodeSlashCommands("continue")[0]?.name, "resume");
  // An alias finds its command.
  assert.equal(filterCodeSlashCommands("stats")[0]?.name, "usage");
  assert.equal(filterCodeSlashCommands("side")[0]?.name, "btw");
  assert.equal(filterCodeSlashCommands("theme")[0]?.name, "theme");
  assert.equal(filterCodeSlashCommands("mo")[0]?.name, "model");
  assert.equal(filterCodeSlashCommands("perm")[0]?.name, "permissions");
  assert.deepEqual(filterCodeSlashCommands("zz-unmatched"), []);
});

test("slash Plan enforces read-only policy on macOS and Windows alike", () => {
  const actions: string[] = [];
  const effects = {
    platform: "darwin" as NodeJS.Platform,
    navigate: (page: string) => actions.push(`page:${page}`),
    settings: (tab: string) => actions.push(`settings:${tab}`),
    model: () => actions.push("model"),
    effort: () => actions.push("effort"),
    permissions: () => actions.push("permissions"),
    plan: (patch: unknown) => actions.push(`plan:${JSON.stringify(patch)}`),
    usage: () => actions.push("usage"),
    compact: () => actions.push("compact"),
    unavailable: (message: string) => actions.push(`unavailable:${message}`),
  };
  const plan = codeSlashCommands.find((value) => value.name === "plan")!;
  executeCodeSlashCommand(plan, effects);
  executeCodeSlashCommand(plan, { ...effects, platform: "win32" });
  executeCodeSlashCommand(
    codeSlashCommands.find((value) => value.name === "model")!,
    effects,
  );
  assert.deepEqual(actions.slice(0, 2), [
    'plan:{"codeSandbox":"read-only","autoAcceptEdits":false,"codePlanMode":true}',
    'plan:{"codeSandbox":"read-only","autoAcceptEdits":false,"codePlanMode":true}',
  ]);
  assert.equal(actions[2], "model");
});

test("slash model and effort arguments resolve against configured models without forwarding a prompt", () => {
  const providers = [
    {
      id: "fixture",
      name: "Fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      protocol: "responses" as const,
      model: "grok-4.6",
      models: ["grok-4.6", "gpt-test"],
    },
  ];
  assert.deepEqual(
    resolveCodeSlashArgument("model", "GPT-TEST", providers, "fixture"),
    { kind: "model", providerId: "fixture", model: "gpt-test" },
  );
  assert.deepEqual(
    resolveCodeSlashArgument("effort", "max", providers, "fixture"),
    { kind: "effort", value: "max" },
  );
  assert.deepEqual(
    resolveCodeSlashArgument("model", "", providers, "fixture"),
    { kind: "action" },
  );
  assert.match(
    resolveCodeSlashArgument("model", "unknown", providers, "fixture").kind,
    /error/,
  );
});

test("/theme takes light, dark or system, and /fast answers with a notice (R-0400)", () => {
  assert.deepEqual(resolveCodeSlashArgument("theme", "Dark", [], ""), {
    kind: "theme",
    value: "dark",
  });
  assert.deepEqual(resolveCodeSlashArgument("theme", "auto", [], ""), {
    kind: "theme",
    value: "system",
  });
  assert.equal(resolveCodeSlashArgument("theme", "pink", [], "").kind, "error");
  assert.equal(resolveCodeSlashArgument("theme", "", [], "").kind, "action");
  const messages: string[] = [];
  const fast = codeSlashCommands.find((value) => value.name === "fast")!;
  executeCodeSlashCommand(fast, {
    platform: "darwin",
    navigate: () => {},
    settings: () => {},
    model: () => {},
    effort: () => {},
    permissions: () => {},
    plan: () => {},
    usage: () => {},
    compact: () => {},
    unavailable: (message) => messages.push(message),
  });
  assert.match(messages[0], /^Fast mode unavailable: /);
});

test("/handoff runs when typed in an idle conversation and is not in the unfiltered list", () => {
  const handoff = codeSlashCommands.find((value) => value.name === "handoff")!;
  assert.equal(handoff.typedOnly, true);
  assert.equal(handoff.conversation, true);
  assert.equal(
    filterCodeSlashCommands("").some((value) => value.name === "handoff"),
    false,
  );
  assert.equal(filterCodeSlashCommands("handoff")[0]?.name, "handoff");
  const idle = (conversationIdle: boolean) =>
    availableCodeSlashCommands({ conversationIdle, planAllowed: true }).some(
      (value) => value.name === "handoff",
    );
  assert.equal(idle(true), true);
  assert.equal(idle(false), false);
  const seen: string[] = [];
  const effects = {
    platform: "darwin" as NodeJS.Platform,
    navigate() {},
    settings() {},
    model() {},
    effort() {},
    permissions() {},
    plan() {},
    usage() {},
    compact() {},
    unavailable: (message: string) => seen.push(`unavailable:${message}`),
  };
  executeCodeSlashCommand(handoff, effects);
  executeCodeSlashCommand(handoff, {
    ...effects,
    handOff: () => seen.push("handoff"),
  });
  assert.deepEqual(seen, [
    "unavailable:Hand off isn't available for this session.",
    "handoff",
  ]);
});

test("/btw hands its text to the side chat, and says so where there is none", () => {
  const seen: string[] = [];
  const base = {
    platform: "darwin" as NodeJS.Platform,
    navigate() {},
    settings() {},
    model() {},
    effort() {},
    permissions() {},
    plan() {},
    usage() {},
    compact() {},
    unavailable: (message: string) => seen.push(`unavailable:${message}`),
  };
  const btw = codeSlashCommands.find((value) => value.name === "btw")!;
  executeCodeSlashCommand(btw, { ...base, btw: () => seen.push("btw") });
  executeCodeSlashCommand(btw, base);
  assert.deepEqual(seen, [
    "btw",
    "unavailable:Open a session to use side chat",
  ]);
});

test("/copy [N] is listed only with a session open and hands its argument on", () => {
  const listed = (hasSession: boolean) =>
    availableCodeSlashCommands({
      conversationIdle: false,
      hasSession,
      planAllowed: true,
    }).some((value) => value.name === "copy");
  assert.equal(listed(true), true);
  assert.equal(listed(false), false);
  const copy = codeSlashCommands.find((value) => value.name === "copy")!;
  assert.equal(copy.argumentHint, "[N]");
  assert.equal(
    copy.description,
    "Copy Claudex’s latest reply, or /copy 2 or higher for an earlier one",
  );
  const seen: string[] = [];
  const effects = {
    platform: "darwin" as NodeJS.Platform,
    navigate() {},
    settings() {},
    model() {},
    effort() {},
    permissions() {},
    plan() {},
    usage() {},
    compact() {},
    unavailable: (message: string) => seen.push(`unavailable:${message}`),
  };
  executeCodeSlashCommand(
    copy,
    { ...effects, copy: (n) => seen.push(`copy:${n}`) },
    "2",
  );
  executeCodeSlashCommand(copy, effects);
  assert.deepEqual(seen, [
    "copy:2",
    "unavailable:There’s no reply to copy yet.",
  ]);
});

test("the palette finds a command by its name or alias only, not by description or scattered letters", () => {
  // "session" is in many descriptions, in no name.
  assert.deepEqual(filterCodeSlashCommands("session"), []);
  assert.deepEqual(filterCodeSlashCommands("rnm"), []);
  assert.equal(filterCodeSlashCommands("nam")[0]?.name, "rename");
});

test("the notices a slash command shows follow the language, with their values filled in", async () => {
  const unknown = () =>
    resolveCodeSlashArgument("effort", "huge", [], "") as {
      kind: string;
      message: string;
    };
  assert.equal(unknown().message, "Unknown effort level: huge");
  try {
    await setLocale("zh-CN");
    assert.equal(unknown().message, "未知的推理强度：huge");
    const seen: string[] = [];
    executeCodeSlashCommand(
      codeSlashCommands.find((value) => value.name === "cd")!,
      {
        platform: "darwin",
        navigate() {},
        settings() {},
        model() {},
        effort() {},
        permissions() {},
        plan() {},
        usage() {},
        compact() {},
        unavailable: (message) => seen.push(message),
      },
    );
    assert.deepEqual(seen, ["/cd 目前在此客户端中尚不可用。"]);
  } finally {
    await setLocale("en-US");
  }
});

test("a draft lists none of the session commands, as the host registry's hasSession gate", () => {
  const names = (hasSession: boolean) =>
    availableCodeSlashCommands({
      conversationIdle: hasSession,
      hasSession,
      planAllowed: true,
    }).map((command) => command.name);
  const draft = names(false);
  for (const name of [
    "btw",
    "rewind",
    "fork",
    "feedback",
    "output-style",
    "rename",
    "export",
    "add-dir",
    "cd",
    "diff",
    "tasks",
    "status",
    "autocompact",
  ])
    assert.ok(!draft.includes(name), `/${name} is not listed in a draft`);
  for (const name of ["model", "effort", "plan", "usage", "workflows", "theme"])
    assert.ok(draft.includes(name), `/${name} stays in a draft`);
  assert.ok(names(true).includes("rewind"));
  assert.ok(names(true).includes("status"));
});

test("typing a space after a bare /name that names one command resolves it, the rest is its argument", () => {
  const commands = availableCodeSlashCommands({
    conversationIdle: true,
    planAllowed: true,
  });
  const resolved = autoResolveSlash("/effort", "/effort high", commands);
  assert.equal(resolved?.command.name, "effort");
  assert.equal(resolved?.rest, "high");
  // By alias, in any case, with nothing after the space yet.
  assert.equal(
    autoResolveSlash("/Stats", "/Stats ", commands)?.command.name,
    "usage",
  );
  assert.equal(autoResolveSlash("/Stats", "/Stats ", commands)?.rest, "");
  // A name that is only a prefix, an unknown name, or text not just typed: nothing.
  assert.equal(autoResolveSlash("/eff", "/eff ", commands), undefined);
  assert.equal(autoResolveSlash("/nope", "/nope ", commands), undefined);
  assert.equal(autoResolveSlash("/effort", "/effortx", commands), undefined);
  assert.equal(
    autoResolveSlash("fix /effort", "fix /effort ", commands),
    undefined,
  );
  assert.equal(
    autoResolveSlash("/effort high", "/effort high ", commands),
    undefined,
  );
});

test("/autocompact takes auto or a token count and is otherwise the context popover", () => {
  const resolve = (value: string) =>
    resolveCodeSlashArgument("autocompact", value, [], "");
  assert.deepEqual(resolve(""), { kind: "action" });
  assert.deepEqual(resolve("auto"), { kind: "autocompact", tokens: 0 });
  assert.deepEqual(resolve("150000"), { kind: "autocompact", tokens: 150000 });
  assert.deepEqual(resolve("150k"), { kind: "autocompact", tokens: 150000 });
  assert.deepEqual(resolve("1.5m"), { kind: "autocompact", tokens: 1500000 });
  assert.deepEqual(resolve("120,000"), { kind: "autocompact", tokens: 120000 });
  for (const bad of ["soon", "12", "-5", "0"])
    assert.equal(resolve(bad).kind, "error", bad);
});

test("/output-style and /feedback act, /add-dir is only typed", () => {
  const base = {
    platform: "darwin" as NodeJS.Platform,
    navigate: () => {},
    settings: () => {},
    model: () => {},
    effort: () => {},
    permissions: () => {},
    plan: () => {},
    usage: () => {},
    compact: () => {},
  };
  const command = (name: string) =>
    codeSlashCommands.find((value) => value.name === name)!;
  const log: string[] = [];
  const actions = {
    ...base,
    outputStyle: (name: string) => log.push(`style:${name}`),
    feedback: () => (log.push("feedback"), true),
    unavailable: (message: string) => log.push(`unavailable:${message}`),
  };
  executeCodeSlashCommand(command("output-style"), actions, " Concise ");
  executeCodeSlashCommand(command("feedback"), actions);
  executeCodeSlashCommand(command("feedback"), {
    ...actions,
    feedback: () => false,
  });
  executeCodeSlashCommand(command("output-style"), {
    ...base,
    unavailable: (message) => log.push(`unavailable:${message}`),
  });
  assert.deepEqual(log, [
    "style:Concise",
    "feedback",
    "unavailable:Feedback isn’t available for this session.",
    "unavailable:Open a session to set its output style.",
  ]);
  assert.equal(command("add-dir").typedOnly, true);
  assert.ok(
    !filterCodeSlashCommands("").some((value) => value.name === "add-dir"),
  );
});
