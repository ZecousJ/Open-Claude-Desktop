import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { detectServerCandidatesWithAgent } from "../../electron/browser/dev-server-candidates";
import { gatewayCompleter } from "../../electron/memory/completion";

async function fixture(t: TestContext) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "dev-candidates-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const root = await fs.realpath(folder);
  await fs.mkdir(path.join(root, "tools", "preview"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { local: "node tools/preview/main.cjs" },
    }),
  );
  await fs.writeFile(
    path.join(root, "tools", "preview", "main.cjs"),
    "require('http').createServer().listen(6931);\n",
  );
  return root;
}

test("AI Detect can find and read a custom server's nested source through the gateway", async (t) => {
  const root = await fixture(t);
  const queries = [
    { inspect: { kind: "Glob", pattern: "tools/**/*.cjs" } },
    { inspect: { kind: "Grep", path: "tools", query: "createServer" } },
    { inspect: { kind: "Read", path: "tools/preview/main.cjs" } },
    {
      candidates: [
        { runtimeExecutable: "npm", runtimeArgs: ["run", "local"], port: 6931 },
      ],
    },
  ];
  let call = 0;
  const complete = gatewayCompleter(
    async () => ({
      url: "http://gateway.test/v1",
      token: "fixture",
      model: "fixture",
    }),
    async (_url, request) => {
      const [
        {
          content: [{ text }],
        },
      ] = JSON.parse(String(request?.body)).input;
      const input = JSON.parse(text);
      assert.equal(input.scripts.local, "node tools/preview/main.cjs");
      if (call === 0) assert.doesNotMatch(text, /6931/);
      const evidence = input.inspections.at(-1)?.result;
      if (call === 1)
        assert.deepEqual(evidence.paths, ["tools/preview/main.cjs"]);
      if (call === 2)
        assert.deepEqual(evidence.matches, [
          {
            path: "tools/preview/main.cjs",
            line: 1,
            text: "require('http').createServer().listen(6931);",
          },
        ]);
      if (call === 3) assert.match(evidence.content, /listen\(6931\)/);
      const delta = JSON.stringify(queries[call++]);
      return new Response(
        [
          { type: "response.output_text.delta", delta },
          { type: "response.completed", response: { output: [] } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    },
  );
  assert.deepEqual(
    await detectServerCandidatesWithAgent(
      root,
      complete,
      new AbortController().signal,
    ),
    {
      ok: true,
      candidates: [
        {
          name: "local",
          runtimeExecutable: "npm",
          runtimeArgs: ["run", "local"],
          port: 6931,
          framework: "unknown",
          validation: { status: "ok" },
        },
      ],
    },
  );
  assert.equal(call, queries.length);
  await assert.rejects(fs.stat(path.join(root, ".claude", "launch.json")), {
    code: "ENOENT",
  });
});

test("AI Detect cannot read outside the project and stops when cancelled", async (t) => {
  const root = await fixture(t);
  const external = await fixture(t);
  await fs.symlink(external, path.join(root, "external"), "junction");
  const controller = new AbortController();
  const reason = new Error("account retired");
  let call = 0;
  await assert.rejects(
    detectServerCandidatesWithAgent(
      root,
      async ({ input }, options) => {
        assert.equal(options?.signal, controller.signal);
        assert.doesNotMatch(input, /listen\(6931\)/);
        if (call > 0)
          assert.equal(
            JSON.parse(input).inspections.at(-1).result.unavailable,
            true,
          );
        switch (call++) {
          case 0:
            return '{"inspect":{"kind":"Read","path":"../outside/package.json"}}';
          case 1:
            return '{"inspect":{"kind":"Read","path":"external/tools/preview/main.cjs"}}';
          default:
            controller.abort(reason);
            return '{"inspect":{"kind":"Read","path":"tools/preview/main.cjs"}}';
        }
      },
      controller.signal,
    ),
    reason,
  );
  assert.equal(call, 3);
});

test("AI Detect stops when the model keeps requesting inspections", async (t) => {
  const root = await fixture(t);
  const budgets: boolean[] = [];
  const result = await detectServerCandidatesWithAgent(
    root,
    async ({ input }) => {
      budgets.push(JSON.parse(input).canInspect);
      assert.ok(budgets.length <= 6);
      return '{"inspect":{"kind":"Read","path":"tools/preview/main.cjs"}}';
    },
    new AbortController().signal,
  );
  assert.deepEqual(budgets, [true, true, true, true, true, false]);
  assert.deepEqual(result, { ok: false, candidates: [], reason: "no-result" });
});
