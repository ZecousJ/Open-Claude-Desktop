import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeMessageText,
  claudeTurns,
  claudeConversation,
  claudeProject,
} from "../../electron/conversations/claude-transcripts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeAiImport } from "../../electron/conversations/claude-ai-import";
import JSZip from "jszip";
import { HistoryImporter } from "../../electron/conversations/history-import";
import type { Conversation, Project } from "../../shared/types";

async function exportFixture(responses: Response[], waits: number[] = []) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-remote-import-"),
  );
  const requests: { url: string; init?: RequestInit }[] = [];
  const importer = new ClaudeAiImport({
    root: () => root,
    open: async () => {},
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      assert.equal(init?.redirect, "error");
      const response = responses.shift();
      assert.ok(response, "no unexpected requests");
      return response;
    },
    wait: (async (milliseconds) => {
      waits.push(milliseconds ?? 0);
    }) as typeof import("node:timers/promises").setTimeout,
  });
  Object.assign(importer, {
    credentials: {
      root,
      token: "secret",
      organization: "organization",
      email: "owner@example.test",
      expiresAt: Date.now() + 900000,
    },
  });
  return {
    importer,
    root,
    requests,
    close: async () => {
      importer.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const exportId = "export_1234567890123456";

test("remote export polls with bounded retries and never sends credentials to signed storage", async () => {
  const waits: number[] = [];
  const fixture = await exportFixture(
    [
      Response.json({ export_id: exportId, poll_after_seconds: 1 }),
      new Response(null, { status: 429, headers: { "retry-after": "1000" } }),
      Response.json({ state: "pending" }),
      Response.json({ state: "ready" }),
      Response.json({
        signed_url: "https://storage.googleapis.com/export/file.zip",
      }),
      new Response(new Uint8Array([80, 75, 3, 4, 1, 2, 3])),
    ],
    waits,
  );
  try {
    const files = await fixture.importer.download();
    assert.equal(files.length, 1);
    assert.equal((await fs.stat(files[0])).mode & 0o777, 0o600);
    assert.deepEqual(waits, [3000, 60000, 5000]);
    for (const request of fixture.requests.slice(0, -1))
      assert.equal(
        new Headers(request.init?.headers).get("Authorization"),
        "Bearer secret",
      );
    assert.equal(fixture.requests.at(-1)?.init?.headers, undefined);
  } finally {
    await fixture.close();
  }
});

test("remote export rejects invalid state and unsafe signed URLs without downloading", async () => {
  for (const state of ["expired", "consumed", "unknown"]) {
    const fixture = await exportFixture([
      Response.json({ export_id: exportId }),
      Response.json({ state }),
    ]);
    try {
      await assert.rejects(fixture.importer.download());
    } finally {
      await fixture.close();
    }
  }
  const fixture = await exportFixture([
    Response.json({ export_id: exportId }),
    Response.json({ state: "ready" }),
    Response.json({
      signed_url: "https://storage.googleapis.com.attacker.test/export.zip",
    }),
  ]);
  try {
    await assert.rejects(fixture.importer.download());
    assert.equal(fixture.requests.length, 3);
    assert.deepEqual(
      await fs.readdir(path.join(fixture.root, "claude-ai-import")),
      [],
    );
  } finally {
    await fixture.close();
  }
});

test("multipart export skips non-importable categories and deletes a failed download", async () => {
  const endpoint =
    "https://claude.ai/api/oauth/organizations/organization/members/me/export_data";
  const fixture = await exportFixture([
    Response.json({ export_id: exportId }),
    Response.json({ state: "ready" }),
    Response.json({ signed_url: "https://storage.googleapis.com/manifest" }),
    Response.json({
      version: "1",
      data_files: [
        { category: "attachments", export_url: "https://invalid.test/skip" },
        {
          category: "conversations",
          export_url: `${endpoint}/export_part1234567890`,
        },
      ],
    }),
    Response.json({ signed_url: "https://storage.googleapis.com/part.zip" }),
    new Response("truncated", { headers: { "content-length": "200" } }),
  ]);
  try {
    await assert.rejects(fixture.importer.download());
    assert.deepEqual(
      await fs.readdir(path.join(fixture.root, "claude-ai-import")),
      [],
    );
  } finally {
    await fixture.close();
  }
});

test("claude export conversion keeps text and filters executable metadata", () => {
  assert.equal(
    claudeMessageText([
      { type: "text", text: "hello" },
      { type: "tool_use", name: "rm" },
    ]),
    "hello",
  );
  const turns = claudeTurns([
    {
      uuid: "u1",
      sender: "human",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      uuid: "u1",
      sender: "human",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      uuid: "u2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "safe answer" }],
      },
    },
    {
      uuid: "u3",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hidden" }],
      },
    },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "hello");
  assert.equal(turns[0].items[0]?.text, "safe answer");
  assert.equal(
    claudeConversation({ uuid: "conv", name: "Imported", chat_messages: [] })
      ?.id,
    "claude-ai:conv",
  );
  assert.equal(
    claudeProject({ uuid: "project", name: "Work" })?.id,
    "claude-ai:project",
  );
});

test("a claude.ai ZIP imports linked projects and transcripts through the history pipeline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-claude-zip-"));
  try {
    const archive = new JSZip();
    archive.file(
      "conversations.json",
      JSON.stringify([
        {
          uuid: "conversation",
          name: "Imported conversation",
          project_uuid: "project",
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-02T00:00:00Z",
          chat_messages: [
            { uuid: "human", sender: "human", text: "Hello" },
            {
              uuid: "assistant",
              sender: "assistant",
              content: [
                { type: "text", text: "Answer" },
                { type: "tool_use", name: "shell" },
              ],
            },
          ],
        },
      ]),
    );
    archive.file(
      "projects/project.json",
      JSON.stringify({
        uuid: "project",
        name: "Imported project",
        prompt_template: "Be concise",
      }),
    );
    const filename = path.join(root, "export.zip");
    await fs.writeFile(
      filename,
      await archive.generateAsync({ type: "nodebuffer" }),
    );
    const store = {
      root,
      conversations: [] as Conversation[],
      projects: [] as Project[],
      flush() {},
    };
    const importer = new HistoryImporter(store);
    const added = await importer.add("file", filename);
    assert.ok(added && "source" in added);
    const result = await importer.run([added.source.id], 0);
    assert.equal(result.ok, true);
    assert.equal(store.conversations[0].projectId, "claude-ai:project");
    assert.equal(store.conversations[0].turns[0].prompt, "Hello");
    assert.equal(store.conversations[0].turns[0].items[0].text, "Answer");
    assert.equal(store.projects[0].instructions, "Be concise");
    const again = await importer.run([added.source.id], 0);
    assert.equal(again.imported.conversations, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
