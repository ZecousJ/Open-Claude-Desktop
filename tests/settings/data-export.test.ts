import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import JSZip from "jszip";
import { ArtifactLibrary } from "../../electron/artifacts/artifact-library";
import { exportArchive } from "../../electron/conversations/data-export";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { defaultSettings } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

function profile(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-data-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, conversations: [], projects: [], settings: defaultSettings };
}

function conversation(id: string, patch: Partial<Conversation>): Conversation {
  return {
    id,
    title: id,
    mode: "chat",
    providerId: "local",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turns: [],
    ...patch,
  };
}

test("export keeps imported artifact snapshots without their share token", async (t) => {
  const input = profile(t);
  const token = "artifact_token1234567890";
  const { artifact } = new ArtifactLibrary(input.root, () => 123).importShared(
    token,
    { name: "Shared chart", language: "html", content: "<h1>Chart</h1>" },
  );
  const zip = await JSZip.loadAsync(exportArchive(input));
  const library = await zip.file("artifact-library.json")?.async("string");
  assert.ok(library);
  assert.doesNotMatch(library, new RegExp(token));
  assert.deepEqual(JSON.parse(library), {
    version: 1,
    copies: [
      {
        libraryId: artifact.libraryId,
        name: "Shared chart",
        language: "html",
        content: "<h1>Chart</h1>",
        createdAt: 123,
      },
    ],
    pinned: [],
  });
});

test("export keeps valid artifact libraries whose JSON is larger than the saved content", async (t) => {
  const input = profile(t);
  const content = '<span class="card">Text</span>'.repeat(62_000);
  const copies = Array.from({ length: 11 }, () => ({
    libraryId: randomUUID(),
    name: "Saved chart",
    language: "html",
    content,
    createdAt: 123,
  }));
  const file = path.join(input.root, "artifact-library.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, copies, pinned: [] }));
  assert.ok(fs.statSync(file).size > 20 * 1024 * 1024);
  assert.equal(new ArtifactLibrary(input.root).list().copies.length, 11);

  const zip = await JSZip.loadAsync(exportArchive(input));
  const library = await zip.file("artifact-library.json")?.async("string");
  assert.ok(library);
  const exportedCopies = JSON.parse(library).copies;
  assert.equal(exportedCopies.length, 11);
  assert.equal(exportedCopies[10].content.length, content.length);
});

test("export removes MCP header values even when the name does not identify a credential", async (t) => {
  const zip = await JSZip.loadAsync(
    exportArchive({
      ...profile(t),
      settings: {
        ...defaultSettings,
        mcpServers: {
          custom: {
            command: "npx",
            args: [
              "mcp-remote",
              "https://mcp.example.com/sse",
              "--header",
              "X-Workspace: workspace-secret",
              "--header=X-Access: access-secret",
            ],
          },
        },
      },
    }),
  );
  const settings = await zip.file("settings.json")?.async("string");
  assert.ok(settings);
  assert.deepEqual(JSON.parse(settings).mcpServers.custom.args, [
    "mcp-remote",
    "https://mcp.example.com/sse",
    "--header",
    "X-Workspace: <redacted>",
    "--header=X-Access: <redacted>",
  ]);
});

test("export includes saved memory switches even without remembered text", async (t) => {
  const input = profile(t);
  await new LocalMemoryStore(input.root).setPrefs({
    searchChats: false,
    generate: true,
  });
  const zip = await JSZip.loadAsync(exportArchive(input));
  const memory = await zip.file("memory.json")?.async("string");
  assert.ok(memory);
  assert.deepEqual(JSON.parse(memory), {
    switches: { searchChats: false, generate: true },
    documents: [],
    edits: [],
  });
});

test("Markdown assigns distinct names and avoids Windows device names", async (t) => {
  const zip = await JSZip.loadAsync(
    exportArchive({
      ...profile(t),
      conversations: [
        conversation("one", { title: "Release notes" }),
        conversation("two", { title: "Release Notes" }),
        conversation("three", { title: "CON.txt" }),
      ],
    }),
  );
  const transcripts = zip.file(/^conversations\/.*\.md$/);
  assert.equal(
    new Set(transcripts.map((file) => file.name.toLowerCase())).size,
    3,
  );
  assert.ok(
    transcripts.every((file) => !/^conversations\/CON\./i.test(file.name)),
  );
  assert.deepEqual(
    (await Promise.all(transcripts.map((file) => file.async("string")))).sort(),
    ["# CON.txt\n\n", "# Release Notes\n\n", "# Release notes\n\n"],
  );
});

test("export limits conversations by start date and leaves other data in the ZIP", async (t) => {
  const input = profile(t);
  const start = Date.UTC(2026, 9, 15);
  const end = Date.UTC(2026, 10, 1);
  const zip = await JSZip.loadAsync(
    exportArchive({
      ...input,
      conversations: [
        conversation("updated during range", {
          createdAt: start - 1,
          updatedAt: start,
        }),
        conversation("created at start", { createdAt: start }),
        conversation("archived code", {
          mode: "code",
          archived: true,
          createdAt: end - 1,
        }),
        conversation("created at end", { createdAt: end }),
        conversation("private within range", {
          incognito: true,
          createdAt: start,
        }),
      ],
      projects: [
        {
          id: "p",
          name: "Project",
          description: "",
          instructions: "Check the release notes.",
          createdAt: 1,
        },
      ],
      conversationRange: { start, end },
    }),
  );
  const conversations = await zip.file("conversations.json")?.async("string");
  assert.ok(conversations);
  assert.deepEqual(
    JSON.parse(conversations).map((item: Conversation) => item.id),
    ["created at start", "archived code"],
  );
  assert.deepEqual(
    zip
      .file(/^conversations\/.*\.md$/)
      .map((entry) => entry.name)
      .sort(),
    ["conversations/archived code.md", "conversations/created at start.md"],
  );
  const projects = await zip.file("projects.json")?.async("string");
  assert.match(projects ?? "", /Check the release notes\./);
  assert.ok(zip.file("settings.json"));
});
