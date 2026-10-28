import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowScript,
  runWorkflowScript,
  WorkflowStopped,
  type AgentOptions,
} from "../../electron/workflows/script";

const script = (body: string) => `export const meta = {
  name: 'review',
  description: 'Review the changes',
  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'check each finding' }],
}
${body}`;

function host() {
  const calls: { prompt: string; options: AgentOptions }[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  let running = 0;
  let peak = 0;
  return {
    calls,
    logs,
    phases,
    peak: () => peak,
    host: {
      async agent(prompt: string, options: AgentOptions) {
        calls.push({ prompt, options });
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (prompt.includes("boom")) throw new Error("agent died");
        return options.schema ? { ok: true, prompt } : `done: ${prompt}`;
      },
      log: (m: string) => logs.push(m),
      phase: (t: string) => phases.push(t),
    },
  };
}
const run = (
  body: string,
  h = host(),
  extra: Partial<Parameters<typeof runWorkflowScript>[2]> = {},
) =>
  runWorkflowScript(parseWorkflowScript(script(body)).body, h.host, {
    concurrency: 2,
    maxAgents: 50,
    signal: new AbortController().signal,
    ...extra,
  });

test("meta is read as a pure literal", () => {
  const { meta } = parseWorkflowScript(script("return 1"));
  assert.equal(meta.name, "review");
  assert.deepEqual(
    meta.phases.map((p) => p.title),
    ["Review", "Verify"],
  );
  assert.throws(() => parseWorkflowScript("const x = 1"), /must begin with/);
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: foo, description: 'x' }\n",
      ),
    /pure literal/,
  );
  assert.throws(
    () => parseWorkflowScript(script("import fs from 'fs'")),
    /cannot import/,
  );
});

test("agents, parallel and pipeline run with a concurrency cap", async () => {
  const h = host();
  const result = await run(
    `phase('Review')
     log('start')
     const found = await parallel([1,2,3,4].map(n => () => agent('find ' + n, { label: 'f' + n })))
     const checked = await pipeline(['a','b'], x => agent('check ' + x, { schema: { type: 'object' } }), r => r.ok)
     const failed = await parallel([() => agent('boom')])
     return { found, checked, failed, args }`,
    h,
    { args: { k: 1 } },
  );
  assert.deepEqual(result, {
    found: ["done: find 1", "done: find 2", "done: find 3", "done: find 4"],
    checked: [true, true],
    failed: [null],
    args: { k: 1 },
  });
  assert.ok(h.peak() <= 2);
  assert.deepEqual(h.phases, ["Review"]);
  assert.deepEqual(h.logs, ["start"]);
});

test("non-deterministic calls and module access are refused", async () => {
  await assert.rejects(
    run("return Date.now()"),
    /Date\.now\(\) is unavailable/,
  );
  await assert.rejects(
    run("return Math.random()"),
    /Math\.random\(\) is unavailable/,
  );
  await assert.rejects(run("return new Date()"), /without arguments/);
  assert.equal(await run("return new Date(0).getTime()"), 0);
  await assert.rejects(run("return eval('1')"), /Code generation from strings/);
  assert.equal(
    await run("return typeof process + typeof globalThis.require"),
    "undefinedundefined",
  );
  assert.throws(
    () => parseWorkflowScript(script("return require('fs')")),
    /cannot import/,
  );
});

test("a stopped run refuses new agents and the agent cap holds", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run("return agent('x')", host(), { signal: controller.signal }),
    WorkflowStopped,
  );
  await assert.rejects(
    run("for (let i = 0; i < 3; i++) await agent('a' + i)", host(), {
      maxAgents: 2,
    }),
    /more than 2 agents/,
  );
});
