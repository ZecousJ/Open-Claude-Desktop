/** Renders synthetic Claudex Code turns in the recovered official frontend. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Conversation } from "../../shared/types";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";

const source =
  process.env.CLAUDE_FRONTEND_SOURCE ??
  path.join(os.homedir(), "Developer/claude-frontend-4.4212.0");
const requireSource = createRequire(path.join(source, "package.json"));
const { _electron } = requireSource("playwright-core");
const electron = requireSource("electron") as string;
const temp = await mkdtemp(path.join(os.tmpdir(), "claudex-code-render-"));
const sessionId = "local_11111111-1111-4111-8111-111111111111";
const cliId = "22222222-2222-4222-8222-222222222222";
const port = 5238;
const mcpImage =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHksAAAAASUVORK5CYII=";
const conversation: Conversation = {
  id: sessionId,
  title: "Claudex",
  mode: "code",
  cwd: temp,
  providerId: "test",
  model: "test",
  pinned: false,
  archived: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: [
    {
      id: "turn-one",
      prompt: "CODE_RENDER_TEST_QUESTION",
      attachments: [],
      status: "completed",
      createdAt: Date.now(),
      items: [
        {
          id: "command-one",
          type: "commandExecution",
          command: "printf CODE_RENDER_TEST_OUTPUT",
          aggregatedOutput: "CODE_RENDER_TEST_OUTPUT",
          status: "completed",
        },
        {
          id: "file-one",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "/work/code-render-example.txt",
              kind: { type: "add" },
              diff: "CODE_RENDER_FILE_CONTENT\n",
            },
          ],
        },
        {
          id: "file-two",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "/work/code-render-edit.txt",
              kind: { type: "update" },
              diff: "@@ -1,2 +1,2 @@\n-old\n+new\n context\n",
            },
          ],
        },
        {
          id: "file-three",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "/work/code-render-multi.txt",
              kind: { type: "update" },
              diff: "@@ -1,2 +1,2 @@\n-old-one\n+new-one\n context-one\n@@ -20,2 +20,2 @@\n-old-two\n+new-two\n context-two\n",
            },
          ],
        },
        {
          id: "mcp-one",
          type: "mcpToolCall",
          server: "docs",
          tool: "search",
          input: { query: "bike" },
          result: {
            content: [
              { type: "text", text: "CODE_RENDER_MCP_RESULT" },
              { type: "image", mimeType: "image/png", data: mcpImage },
              { type: "audio", mimeType: "audio/wav", data: "AAAA" },
              {
                type: "resource_link",
                uri: "fixture://docs/guide",
                name: "CODE_RENDER_MCP_RESOURCE",
              },
            ],
            structuredContent: { query: "bike" },
            _meta: { ui: { resourceUri: "ui://fixture" } },
          },
          success: true,
          status: "completed",
        },
        {
          id: "plan-one",
          type: "taskPlan",
          plan: [
            { step: "CODE_RENDER_PLAN", status: "completed" },
            { step: "CODE_RENDER_PENDING", status: "pending" },
          ],
        },
        {
          id: "search-one",
          type: "webSearch",
          query: "CODE_RENDER_SEARCH",
          sources: [
            { title: "CODE_RENDER_SOURCE", url: "https://example.test/docs" },
          ],
          lifecycleStatus: "completed",
        },
        {
          id: "outputs-one",
          type: "outputFiles",
          status: "completed",
          generatedFiles: [
            {
              id: "sheet",
              name: "CODE_RENDER_RESULT.xlsx",
              path: "/work/CODE_RENDER_RESULT.xlsx",
              language: "text",
              operation: "create",
              state: "ready",
              bytes: 1234,
              blob: true,
            },
          ],
        },
        {
          id: "answer-one",
          type: "agentMessage",
          text: "CODE_RENDER_TEST_ANSWER",
        },
      ],
    },
    {
      id: "turn-error",
      prompt: "CODE_RENDER_FAILURE_QUESTION",
      attachments: [],
      status: "failed",
      error: "CODE_RENDER_TEST_FAILURE",
      createdAt: Date.now() + 1,
      items: [],
    },
  ],
};
const converted = convertCodeTranscript(conversation);
assert.deepEqual(converted.unsupported, []);
let app: any;
let server: ReturnType<typeof spawn> | undefined;
try {
  const original = JSON.parse(
    await readFile(path.join(source, ".local/replay.json"), "utf8"),
  );
  const metadataPath = path.join(temp, "metadata.json");
  const transcriptPath = path.join(temp, `${cliId}.jsonl`);
  const configPath = path.join(temp, "replay.json");
  await writeFile(
    metadataPath,
    JSON.stringify({
      sessionId,
      cliSessionId: cliId,
      title: "Claudex",
      cwd: temp,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isArchived: false,
    }),
  );
  await writeFile(
    transcriptPath,
    converted.rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await writeFile(
    configPath,
    JSON.stringify({ ...original, metadataPath, transcriptPath }),
  );
  server = spawn(
    path.join(source, "node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: source,
      env: { ...process.env, FRONTEND_REPLAY_CONFIG: configPath },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null)
      throw Error(`Fixture server exited (${server.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {}
    if (i === 119) throw Error("Fixture server did not start");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  app = await _electron.launch({
    executablePath: electron,
    args: [path.join(source, "electron/main.cjs")],
    env: {
      ...process.env,
      FRONTEND_PROFILE: path.join(temp, "profile"),
      FRONTEND_TEST: "1",
      FRONTEND_URL: `http://localhost:${port}/epitaxy/${sessionId}`,
      FRONTEND_REPLAY_CONFIG: configPath,
    },
  });
  const page = await app.firstWindow();
  await page
    .getByText("CODE_RENDER_TEST_QUESTION", { exact: false })
    .first()
    .waitFor({ timeout: 45000 });
  await page
    .getByText("CODE_RENDER_TEST_ANSWER", { exact: false })
    .first()
    .waitFor({ timeout: 15000 });
  await page
    .getByRole("button", { name: /^(Ran|Running) .*command/i })
    .first()
    .waitFor({ timeout: 15000 });
  const details = page.getByRole("button", { name: /view details/i }).first();
  if ((await details.count()) && (await details.isVisible()))
    await details.click();
  try {
    await page
      .getByText("CODE_RENDER_TEST_FAILURE", { exact: false })
      .first()
      .waitFor({ timeout: 15000 });
  } catch (error) {
    throw Error(`The test failure details did not appear; ${error}`);
  }
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("This page ran into a problem"));
  const group = page
    .getByRole("button", { name: /^(Ran|Running) .*command/i })
    .first();
  await group.click({ timeout: 10000 });
  const nestedCommand = page
    .getByRole("button", { name: /^Ran a command$/ })
    .first();
  if ((await nestedCommand.count()) && (await nestedCommand.isVisible()))
    await nestedCommand.click();
  try {
    await page
      .getByText("CODE_RENDER_TEST_OUTPUT", { exact: false })
      .first()
      .waitFor({ timeout: 10000 });
  } catch (error) {
    throw Error(`The test command result did not appear; ${error}`);
  }
  await page
    .getByText("code-render-example.txt", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  await page
    .getByText("code-render-edit.txt", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  const multi = page
    .getByText("code-render-multi.txt", { exact: false })
    .first();
  await multi.waitFor({ timeout: 10000 });
  await multi
    .locator("xpath=ancestor::*[@data-cds-row][1]")
    .locator("[data-cds-row-toggle]")
    .click();
  try {
    await page
      .getByText("new-one", { exact: false })
      .first()
      .waitFor({ timeout: 10000 });
  } catch (error) {
    throw Error(`The test multi-edit details did not appear; ${error}`);
  }
  await page
    .getByText("new-two", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  const tool = page.getByText(/docs[ .:]\s*search/i).last();
  const toolRow = tool.locator("xpath=ancestor::*[@data-cds-row][1]");
  await toolRow.locator("[data-cds-row-toggle]").click();
  await page
    .getByText("CODE_RENDER_MCP_RESULT", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  const preview = page.getByRole("button", { name: /^View Image/i });
  await preview.click({ timeout: 10000 });
  const toolImage = page.getByRole("dialog").locator("img");
  await toolImage.waitFor({ timeout: 10000 });
  assert.equal(
    await toolImage.evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      return image.naturalWidth;
    }),
    1,
  );
  await page.keyboard.press("Escape");
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /CODE_RENDER_MCP_RESOURCE|Unsupported tool content|Tool widget metadata/,
  );
  await page
    .getByText("CODE_RENDER_RESULT.xlsx", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  const search = page.getByText("CODE_RENDER_SEARCH", { exact: false }).last();
  await search.waitFor({ timeout: 10000 });
  const searchToggle = search
    .locator("xpath=ancestor::*[@data-cds-row][1]")
    .locator("[data-cds-row-toggle]");
  if ((await searchToggle.getAttribute("aria-expanded")) !== "true")
    await searchToggle.click();
  await page
    .locator("a:visible")
    .filter({ hasText: "CODE_RENDER_SOURCE" })
    .first()
    .waitFor({ timeout: 10000 });
  const todo = page.getByRole("button", { name: /updated todos/i }).first();
  if (
    (await todo.count()) &&
    (await todo.getAttribute("aria-expanded")) !== "true"
  )
    await todo.click();
  await page
    .getByText("CODE_RENDER_PLAN", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  console.log(
    "Official renderer displays converted messages, a failure, a command result, a created file, single/multi-hunk edits and an MCP tool result.",
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "unchanged recovered official renderer: plans, structured web search sources and binary output file cards plus prior transcript fixtures",
    }),
  );
} finally {
  await app?.close();
  if (server && server.exitCode === null) server.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
