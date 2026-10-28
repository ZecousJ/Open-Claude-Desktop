import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listCustomPrompts,
  maxPromptBytes,
  parsePromptFile,
  readCustomPrompt,
  registerComposerHandlers,
  slashSkills,
} from "../../electron/ipc/composer";
import type { AppContext } from "../../electron/app/app-context";
import {
  availableCodeSlashCommands,
  expandCustomPrompt,
  filterCodeSlashCommands,
  skillMessage,
  slashSourceLabels,
  splitPromptArguments,
} from "../../src/composer/code/code-slash-commands";
import { executeCodeSlashCommand } from "../../src/composer/code/code-slash-actions";

function promptsFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-prompts-"));
  fs.writeFileSync(
    path.join(folder, "review-pr.md"),
    "---\ndescription: Review a pull request\nargument-hint: [pr-number]\n---\nReview PR $1 and report $ARGUMENTS.\n",
  );
  fs.writeFileSync(
    path.join(folder, "plain.md"),
    "# Explain the code\n\nBe brief.",
  );
  fs.writeFileSync(path.join(folder, "has space.md"), "Not typeable");
  fs.writeFileSync(path.join(folder, "notes.txt"), "Not a prompt");
  fs.writeFileSync(
    path.join(folder, "huge.md"),
    "x".repeat(maxPromptBytes + 1),
  );
  fs.writeFileSync(
    path.join(folder, "binary.md"),
    Buffer.from([0xff, 0xfe, 0x00]),
  );
  return folder;
}

test("custom prompts list only small UTF-8 .md files with typeable names", () => {
  const folder = promptsFolder();
  try {
    assert.deepEqual(listCustomPrompts(folder), [
      {
        name: "plain",
        description: "Explain the code",
        source: "prompt",
      },
      {
        name: "review-pr",
        description: "Review a pull request",
        source: "prompt",
        argumentHint: "[pr-number]",
      },
    ]);
    assert.equal(
      readCustomPrompt(folder, "review-pr"),
      "Review PR $1 and report $ARGUMENTS.\n",
    );
    assert.equal(readCustomPrompt(folder, "huge"), null);
    assert.equal(readCustomPrompt(folder, "missing"), null);
    // A name can never walk out of the prompts folder.
    assert.equal(readCustomPrompt(folder, "../review-pr"), null);
    assert.deepEqual(listCustomPrompts(path.join(folder, "absent")), []);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("the palette's list merges prompts, the folder's skills and /usage-credits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-slash-"));
  const prompts = path.join(root, "codex-home", "prompts");
  fs.mkdirSync(prompts, { recursive: true });
  fs.writeFileSync(path.join(prompts, "deploy.md"), "Deploy $1");
  const calls: unknown[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    store: {
      root,
      conversation: (id: string) => ({ id, mode: "code", cwd: "/work/repo" }),
    },
    engine: {
      rpc: {
        call: async (method: string, params: unknown) => {
          calls.push([method, params]);
          return {
            data: [
              {
                skills: [
                  { name: "deploy", description: "Same name as a prompt" },
                  { name: "lint", description: "Lint the repo" },
                ],
              },
            ],
          };
        },
      },
    },
    remote: undefined as unknown,
    allowedFolder: () => {},
    selectedAttachments: new Map(),
  };
  try {
    registerComposerHandlers(
      (name, fn) => handlers.set(name, fn),
      ctx as unknown as AppContext,
    );
    const local = (await handlers.get("listSlashCommands")!({
      conversationId: "c1",
    })) as any;
    assert.deepEqual(calls, [["skills/list", { cwds: ["/work/repo"] }]]);
    assert.deepEqual(
      local.commands.map((c: any) => [c.name, c.source]),
      [
        ["deploy", "prompt"],
        ["lint", "skill"],
      ],
    );
    assert.equal(local.usageCredits, false);
    ctx.remote = {};
    ctx.engine.rpc.call = async () => {
      throw new Error("not running");
    };
    const remote = (await handlers.get("listSlashCommands")!({})) as any;
    assert.equal(remote.usageCredits, true);
    assert.deepEqual(
      remote.commands.map((c: any) => c.name),
      ["deploy"],
    );
    assert.equal(
      await handlers.get("readCustomPrompt")!("deploy"),
      "Deploy $1",
    );
    assert.throws(() => handlers.get("readCustomPrompt")!(42));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a prompts folder or prompt file that is a link reads nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-slash-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-outside-"));
  fs.writeFileSync(path.join(outside, "secret.md"), "Secret");
  fs.mkdirSync(path.join(root, "codex-home"));
  // On a runner the agent can write codex-home and put a link there.
  fs.symlinkSync(outside, path.join(root, "codex-home", "prompts"));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    store: { root, conversation: () => ({ mode: "chat" }) },
    engine: {},
    allowedFolder: () => {},
    selectedAttachments: new Map(),
  };
  try {
    registerComposerHandlers(
      (name, fn) => handlers.set(name, fn),
      ctx as unknown as AppContext,
    );
    const listed = (await handlers.get("listSlashCommands")!({})) as any;
    assert.deepEqual(listed.commands, []);
    assert.equal(await handlers.get("readCustomPrompt")!("secret"), null);
    // A link in place of a prompt file is not followed either.
    fs.rmSync(path.join(root, "codex-home", "prompts"));
    fs.mkdirSync(path.join(root, "codex-home", "prompts"));
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(root, "codex-home", "prompts", "secret.md"),
    );
    assert.equal(await handlers.get("readCustomPrompt")!("secret"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("prompt front matter is optional and quoted values are unwrapped", () => {
  assert.deepEqual(parsePromptFile('---\ndescription: "Quoted"\n---\nBody'), {
    body: "Body",
    description: "Quoted",
    argumentHint: undefined,
  });
  assert.equal(parsePromptFile("Just text").description, "Just text");
});

test("enabled skills become slash commands once each", () => {
  assert.deepEqual(
    slashSkills([
      {
        skills: [
          {
            name: "skill-creator",
            description: "Create skills",
            enabled: true,
          },
          { name: "off", description: "Disabled", enabled: false },
          { name: "has space", description: "Not typeable" },
        ],
      },
      { skills: [{ name: "skill-creator", shortDescription: "Again" }] },
    ]),
    [{ name: "skill-creator", description: "Create skills", source: "skill" }],
  );
  assert.deepEqual(slashSkills(undefined), []);
});

test("custom commands follow the built-in ones and never replace them", () => {
  const list = availableCodeSlashCommands({
    conversationIdle: false,
    planAllowed: true,
    custom: [
      { name: "model", description: "Shadowing prompt", source: "prompt" },
      { name: "review-pr", description: "Review", source: "prompt" },
      { name: "skill-creator", description: "Skills", source: "skill" },
    ],
  });
  assert.equal(list.filter((c) => c.name === "model").length, 1);
  assert.equal(list.find((c) => c.name === "model")?.source, undefined);
  assert.deepEqual(
    list.slice(-2).map((c) => [c.name, c.source]),
    [
      ["review-pr", "prompt"],
      ["skill-creator", "skill"],
    ],
  );
  assert.equal(filterCodeSlashCommands("rev", list)[0]?.name, "review-pr");
});

test("added prompts and skills follow in name order; only prompts carry a tag (R-0401)", () => {
  const list = availableCodeSlashCommands({
    conversationIdle: false,
    planAllowed: true,
    custom: [
      { name: "review-pr", description: "", source: "prompt" },
      { name: "anthropic-skills:pdf", description: "", source: "skill" },
      { name: "Zeta", description: "", source: "skill" },
      { name: "advisor-tips", description: "", source: "prompt" },
    ],
  });
  assert.deepEqual(
    list.slice(-4).map((c) => c.name),
    ["advisor-tips", "anthropic-skills:pdf", "review-pr", "Zeta"],
  );
  assert.equal(slashSourceLabels.prompt, "Custom command");
  assert.equal(slashSourceLabels.skill, undefined);
});

test("/usage-credits is listed only when the account has Billing credits", () => {
  const names = (usageCredits: boolean) =>
    availableCodeSlashCommands({
      conversationIdle: false,
      planAllowed: true,
      usageCredits,
    }).map((c) => c.name);
  assert.equal(names(false).includes("usage-credits"), false);
  assert.equal(names(true).includes("usage-credits"), true);
  const opened: string[] = [];
  executeCodeSlashCommand(
    { name: "usage-credits", description: "" },
    {
      platform: "darwin",
      navigate: () => {},
      settings: (tab) => opened.push(tab),
      model: () => {},
      effort: () => {},
      permissions: () => {},
      plan: () => {},
      usage: () => {},
      compact: () => {},
      unavailable: () => {},
    },
  );
  assert.deepEqual(opened, ["billing"]);
});

test("custom prompts expand positional, named and whole arguments", () => {
  assert.deepEqual(splitPromptArguments(`12 "two words" 'x y'`), [
    "12",
    "two words",
    "x y",
  ]);
  assert.equal(
    expandCustomPrompt("Review PR $1 ($2). All: $ARGUMENTS", `12 "a b"`),
    `Review PR 12 (a b). All: 12 "a b"`,
  );
  assert.equal(
    expandCustomPrompt("Deploy to $ENV costs $$5", "ENV=staging"),
    "Deploy to staging costs $5",
  );
  assert.equal(
    expandCustomPrompt("Unknown $THING stays", ""),
    "Unknown $THING stays",
  );
  assert.equal(
    expandCustomPrompt("Explain the code.", "src/app.ts"),
    "Explain the code.\n\nsrc/app.ts",
  );
  // An empty prompt sends just the arguments, without leading blank lines.
  assert.equal(expandCustomPrompt("", "src/app.ts"), "src/app.ts");
  assert.equal(
    expandCustomPrompt("Missing $2 argument", "only"),
    "Missing  argument",
  );
});

test("a custom command runs through the custom action and a skill sends $name", () => {
  const ran: string[] = [];
  executeCodeSlashCommand(
    { name: "review-pr", description: "", source: "prompt" },
    {
      platform: "darwin",
      navigate: () => {},
      settings: () => {},
      model: () => {},
      effort: () => {},
      permissions: () => {},
      plan: () => {},
      usage: () => {},
      compact: () => {},
      custom: (command) => ran.push(command.name),
      unavailable: (message) => ran.push(message),
    },
  );
  assert.deepEqual(ran, ["review-pr"]);
  assert.equal(
    skillMessage("skill-creator", " make one "),
    "$skill-creator make one",
  );
  assert.equal(skillMessage("skill-creator", ""), "$skill-creator");
});
