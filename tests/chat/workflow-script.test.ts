import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowScript,
  runWorkflowScript,
  WorkflowStopped,
  type AgentOptions,
  type WorkflowHost,
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
const run = async (
  body: string,
  h: { host: WorkflowHost } = host(),
  extra: Partial<Parameters<typeof runWorkflowScript>[2]> = {},
) =>
  runWorkflowScript((await parseWorkflowScript(script(body))).body, h.host, {
    concurrency: 2,
    maxAgents: 50,
    signal: new AbortController().signal,
    ...extra,
  });

test("meta is read in the workflow runtime", async () => {
  const { meta } = await parseWorkflowScript(script("return 1"));
  assert.equal(meta.name, "review");
  assert.deepEqual(
    meta.phases.map((p) => p.title),
    ["Review", "Verify"],
  );
  await assert.rejects(
    () => parseWorkflowScript("const x = 1"),
    /must begin with/,
  );
  await assert.rejects(
    () =>
      parseWorkflowScript(
        "export const meta = { name: foo, description: 'x' }\n",
      ),
    /pure literal/,
  );
  await assert.rejects(
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
  await assert.rejects(
    run('return agent.constructor("return process.version")()'),
    /Code generation from strings/,
  );
  await assert.rejects(
    run('return (await import("node:fs")).readFileSync'),
    /could not load module/,
  );
  await assert.rejects(
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

test("the runtime stops runaway metadata, computation and memory allocation", async () => {
  await assert.rejects(
    parseWorkflowScript("export const meta = { toJSON() { while (true) {} } }"),
    /execution time limit/,
  );
  await assert.rejects(
    run("while (true) await Promise.resolve()"),
    /execution time limit/,
  );
  await assert.rejects(
    run("return new Uint8Array(32 * 1024 * 1024).length"),
    /memory/i,
  );
  assert.equal(await run("return 'next run'"), "next run");
});

test("the runtime limits aggregate allocations within a workflow", async () => {
  const first = "new Uint8Array(15 * 1024 * 1024).fill(1)";
  const second = "new Uint8Array(2 * 1024 * 1024).fill(2)";
  await assert.rejects(
    run(`
      const first = ${first};
      const second = ${second};
      return first[0] + second[0];
    `),
    /out of memory/i,
  );
  const h = host();
  await assert.rejects(
    run(
      `const first = ${first}; const second = await workflow('child'); return first[0] + second;`,
      { host: { ...h.host, loadWorkflow: () => script(`return ${second}[0]`) } },
    ),
    /out of memory/i,
  );
  assert.equal(
    await run(`await 0; const first = ${first}; return first[first.length - 1];`),
    1,
  );
});

test("stopping a workflow discards outstanding guest promises", async () => {
  const controller = new AbortController();
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let finish!: (value: string) => void;
  const result = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const logs: string[] = [];
  const running = run(
    "await agent('one'); log('after agent')",
    {
      ...host(),
      host: {
        agent: () => {
          start();
          return result;
        },
        log: (message) => logs.push(message),
        phase: () => 0,
      },
    },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(running, WorkflowStopped);
  finish("late result");
  assert.equal(await run("return 1"), 1);
  assert.deepEqual(logs, []);
});

test("parallel saved workflows have private arguments and share the parent's agent limits", async () => {
  const h = host();
  const lookup = (name: string) => {
    if (name !== "child") throw Error("Unknown saved workflow");
    return script(`
args.labels.push(args.prompt)
return { labels: args.labels, result: await agent(args.prompt) }
`);
  };
  const result = await run(`
return [
  ...await parallel([
    () => workflow('child', {prompt: 'a', labels: args.labels}),
    () => workflow('child', {prompt: 'b', labels: args.labels}),
    () => agent('parent'),
    () => workflow('child', {prompt: 'over limit', labels: []}),
  ]),
  args.labels,
]
`, { ...h, host: { ...h.host, loadWorkflow: lookup } }, {
    args: { labels: ["original"] }, concurrency: 1, maxAgents: 3,
  });
  assert.deepEqual(result, [
    { labels: ["original", "a"], result: "done: a" },
    { labels: ["original", "b"], result: "done: b" },
    "done: parent",
    null,
    ["original"],
  ]);
  assert.equal(h.peak(), 1);
  assert.deepEqual(h.calls.map(({ prompt }) => prompt), ["a", "b", "parent"]);
});

test("saved workflow errors reach the parent and a child cannot load another workflow", async () => {
  const h = host();
  const results = await run(`
const missing = await workflow('missing').catch(e => e.message);
const invalid = await workflow({scriptPath:'/other.js'}).catch(e => e.message);
const empty = await workflow('empty').catch(e => e.message);
return [missing, invalid, empty, await workflow('child')];
`, { ...h, host: { ...h.host, loadWorkflow: (name: string) => {
    if (name === "missing") throw Error("No saved workflow with this name");
    if (name === "empty") return "";
    assert.equal(name, "child");
    return script(`const phase = typeof args;
    return [
      phase,
      typeof globalThis.loadSavedWorkflow,
      await workflow('grandchild').catch(error => error.message)
    ]`);
  } } });
  assert.deepEqual(results, [
    "No saved workflow with this name",
    "workflow() needs a saved workflow name.",
    "The workflow script is empty.",
    ["undefined", "undefined", "Saved workflows can only run one level inline."],
  ]);
});

test("saved workflows doing pure computation share the parent execution slice", async () => {
  const h = host();
  await assert.rejects(
    run("for (;;) await workflow('child')", {
      ...h,
      host: { ...h.host, loadWorkflow: () => script("return 1") },
    }),
    /execution time limit/,
  );
});
