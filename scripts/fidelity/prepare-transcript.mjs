import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(
  process.argv[2] ?? "../../work/fidelity/transcript-profile",
);
if (fs.existsSync(path.join(root, "settings.json")))
  throw new Error(
    "Use an unused fixture directory; existing profiles are never overwritten.",
  );
fs.mkdirSync(root, { recursive: true });
const time = Date.now();
const prompt =
  "Claudex UI reference 001. This is a synthetic interface test. Please respond with a short heading, one sentence, a three-item checklist, a two-column table with two fictional rows, and a small JavaScript code block that adds two numbers. Use no personal data and no web search.";
const text =
  "### UI Reference Test\n\nThis response demonstrates several common formatting elements for interface rendering checks.\n\n- [x] Heading renders correctly\n- [x] Checklist items display with checkboxes\n- [ ] Table and code block align properly\n\n| Item | Value |\n| --- | --- |\n| Widget Alpha | 42 |\n| Gadget Beta | 17 |\n\n```javascript\nfunction add(a, b) {\n  return a + b;\n}\n\nconsole.log(add(2, 3)); // 5\n```";
const data = {
  "settings.json": {
    theme: "dark",
    name: "Reference test",
    providers: [
      {
        id: "fixture",
        name: "Visual fixture (offline)",
        baseUrl: "http://127.0.0.1:1/v1",
        protocol: "responses",
        model: "Fixture",
        models: ["Fixture"],
      },
    ],
    activeProviderId: "fixture",
    effort: "high",
    sandbox: "read-only",
    instructions: "",
    mcpServers: {},
  },
  "conversations.json": [
    {
      id: "reference-001",
      title: "Synthetic interface test structure",
      mode: "chat",
      providerId: "fixture",
      model: "Fixture",
      pinned: false,
      archived: false,
      createdAt: time,
      updatedAt: time,
      turns: [
        {
          id: "reference-turn-001",
          prompt,
          attachments: [],
          items: [{ id: "reference-message-001", type: "agentMessage", text }],
          status: "completed",
          createdAt: time,
        },
      ],
    },
  ],
  "projects.json": [],
};
if (process.argv.includes("--command") || process.argv.includes("--versions")) {
  const digest =
    "f4feb73d4dd57c61119f530d27e3782ce812140eb40ccd880bbf186e6a0c6dcf";
  data["conversations.json"][0].turns.push({
    id: "reference-turn-002",
    prompt:
      "Claudex UI reference 002: Please use the code execution tool to calculate the SHA-256 of the literal ASCII text pixel-reference-002, then return the digest. This is a synthetic rendering test. Do not use any connected account, personal files, memory, or web search.",
    attachments: [],
    items: [
      {
        id: "reference-command-002",
        type: "commandExecution",
        command: "printf '%s' 'pixel-reference-002' | sha256sum",
        shell: "bash",
        status: "completed",
        aggregatedOutput: digest + "  -\n",
        exitCode: 0,
      },
      {
        id: "reference-message-002",
        type: "agentMessage",
        text:
          "The SHA-256 digest of `pixel-reference-002` (no trailing newline) is:\n\n```\n" +
          digest +
          "\n```",
      },
    ],
    status: "completed",
    createdAt: time,
  });
}
if (process.argv.includes("--versions")) {
  const conversation = data["conversations.json"][0];
  const original = structuredClone(conversation.turns);
  original[1].responseGroupId = original[1].id;
  original.push({
    id: "fixture-continuation",
    prompt: "Synthetic branch continuation. Reply Finished.",
    attachments: [],
    items: [
      {
        id: "fixture-continuation-answer",
        type: "agentMessage",
        text: "Finished",
      },
    ],
    status: "completed",
    createdAt: time + 1,
  });
  conversation.savedBranches = [
    {
      id: "original",
      turns: original,
      providerId: "fixture",
      model: "Fixture",
      visited: 0,
    },
  ];
  conversation.activeBranchId = "alternative";
  conversation.branchVisit = 1;
  conversation.turns[1] = {
    ...conversation.turns[1],
    id: "reference-turn-002-alternative",
    responseGroupId: original[1].id,
    createdAt: time + 2,
    items: [
      conversation.turns[1].items[0],
      {
        id: "alternative-answer",
        type: "agentMessage",
        text: "### SHA-256 Digest\n\nComputed with `printf` (no trailing newline) piped to `sha256sum`.\n\n| Field | Value |\n| --- | --- |\n| Input | `pixel-reference-002` |\n| Digest | `f4feb73d4dd57c61119f530d27e3782ce812140eb40ccd880bbf186e6a0c6dcf` |",
      },
    ],
  };
}
if (process.argv.includes("--edits")) {
  const c = data["conversations.json"][0];
  const original = {
    id: "original-prompt",
    prompt:
      'Claudex UI reference 004. Synthetic interface test only. Use code execution to run Python that prints "group reference" with the numbers 0 through 11, flushing each line and sleeping one second between lines. Then reply "Finished". Do not read files, memory, personal data, connected accounts, or web pages.',
    attachments: [],
    items: [{ id: "finished", type: "agentMessage", text: "Finished" }],
    status: "completed",
    createdAt: time - 7200000,
    promptGroupId: "edit-group",
    promptVersionId: "original-prompt",
    responseGroupId: "original-prompt",
  };
  c.turns = [original];
  c.savedBranches = [
    {
      id: "edited",
      turns: [
        {
          ...original,
          id: "edited-prompt",
          prompt:
            'Claudex UI reference 004. Synthetic edit test only. Reply exactly "Edited reference". Do not use tools, files, memory, connected accounts, personal data, or web search.',
          promptVersionId: "edited-prompt",
          responseGroupId: "edited-prompt",
          createdAt: time,
          items: [
            {
              id: "edited-answer",
              type: "agentMessage",
              text: "Edited reference",
            },
          ],
        },
      ],
      providerId: "fixture",
      model: "Fixture",
      visited: 0,
    },
  ];
  c.activeBranchId = "original";
  c.branchVisit = 1;
}
if (process.argv.includes("--group")) {
  data["conversations.json"][0].turns = [
    {
      id: "reference-turn-003",
      prompt:
        'Claudex UI reference 003. Please use code execution to run a Python loop that prints "reference tick" and its index five times, flushing stdout and waiting one second between each line. Then give an 80-word explanation of streaming output. This is a synthetic interface test; do not read personal data, memory, connected accounts, or web pages.',
      attachments: [],
      status: "completed",
      createdAt: time,
      items: [
        {
          id: "reference-command-003",
          type: "commandExecution",
          shell: "bash",
          command: `python3 -u -c '\nimport sys, time\nfor i in range(5):\n    print(f"reference tick {i}", flush=True)\n    if i < 4:\n        time.sleep(1)\n'`,
          status: "completed",
          aggregatedOutput:
            "reference tick 0\nreference tick 1\nreference tick 2\nreference tick 3\nreference tick 4\n",
          exitCode: 0,
        },
        {
          id: "reference-reasoning-003",
          type: "reasoning",
          summary: ["Explaining how streaming output works."],
          lifecycleStatus: "completed",
        },
        {
          id: "reference-message-003",
          type: "agentMessage",
          text: "Output:\n\n```\nreference tick 0\nreference tick 1\nreference tick 2\nreference tick 3\nreference tick 4\n```\n\nStreaming output means a program sends data to its destination as it is produced, rather than holding everything until completion.",
        },
      ],
    },
  ];
}
if (process.argv.includes("--file")) {
  const html = fs.readFileSync(
    new URL("./fixtures/reference-card.html", import.meta.url),
    "utf8",
  );
  data["conversations.json"][0].turns = [
    {
      id: "reference-turn-005",
      prompt:
        'Claudex UI reference 005. Synthetic interface test only. Create a standalone HTML artifact named "Synthetic interface card" a plain page with the heading "Reference card" a counter starting at 0 and a button that adds 1. Use only inline HTML CSS and JavaScript no external assets or network requests. Do not read personal files memory connected accounts or web pages. Keep the code under 35 lines.',
      attachments: [],
      status: "completed",
      createdAt: time,
      items: [
        {
          id: "file-message",
          type: "agentMessage",
          text:
            "```html\n" +
            html +
            "```\n\nDone — 33 lines, fully inline, no external assets or network calls. The counter starts at 0 and the button increments it.",
        },
      ],
    },
  ];
}
if (process.argv.includes("--generated-file")) {
  const html = fs.readFileSync(
    new URL("./fixtures/reference-card.html", import.meta.url),
    "utf8",
  );
  const filename = "synthetic-interface-card.html";
  const renamedButton = html.replaceAll("Add 1", "Add 2");
  const updated = renamedButton.replace("n += 1", "n += 2");
  const makeItem = (id, content, operation) => ({
    id,
    type: "fileChange",
    status: "completed",
    lifecycleStatus: "completed",
    changes: [
      {
        path: filename,
        kind: { type: operation === "create" ? "add" : "update" },
        diff: "",
      },
    ],
    generatedFiles: [
      {
        id: id + ":0",
        name: filename,
        path: "/synthetic/" + filename,
        language: "html",
        operation,
        state: "ready",
        content,
        digest: createHash("sha256").update(content).digest("hex"),
        capturedAt: time,
        bytes: Buffer.byteLength(content),
      },
    ],
  });
  data["conversations.json"][0].turns = [
    {
      id: "file-create",
      prompt:
        'Claudex UI reference 005. Synthetic interface test only. Create a standalone HTML artifact named "Synthetic interface card" a plain page with the heading "Reference card" a counter starting at 0 and a button that adds 1. Use only inline HTML CSS and JavaScript no external assets or network requests. Do not read personal files memory connected accounts or web pages. Keep the code under 35 lines.',
      attachments: [],
      status: "completed",
      createdAt: time,
      items: [
        makeItem("create", html, "create"),
        {
          id: "file-create-reply",
          type: "agentMessage",
          text: "Done — 33 lines, fully inline, no external assets or network calls. The counter starts at 0 and the button increments it.",
        },
      ],
    },
    {
      id: "file-update",
      prompt:
        'Claudex UI reference 006. Synthetic update test only. Update the HTML document you created in reference 005 so the button label is "Add 2" and each click adds 2 instead of 1. Keep the existing layout and title. Do not read personal files, memory, connected accounts, or web pages, and do not use external assets.',
      attachments: [],
      status: "completed",
      createdAt: time,
      items: [
        makeItem("update-label", renamedButton, "update"),
        makeItem("update-counter", updated, "update"),
        {
          id: "file-update-reply",
          type: "agentMessage",
          text: 'Updated in place — the button now reads "Add 2" and each click increments the counter by 2. Layout, title, and styling are unchanged.',
        },
      ],
    },
  ];
}
for (const [name, value] of Object.entries(data))
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
fs.writeFileSync(
  path.join(root, "FIXTURE.md"),
  "Offline synthetic transcript. Reconstructed from our own reference conversation through the Claude UI. No live provider or secret. Not evidence of agent execution.\n",
);
console.log(root);
