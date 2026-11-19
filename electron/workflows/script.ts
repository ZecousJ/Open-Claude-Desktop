/**
 * Workflow scripts (the official Workflow tool's format, Claude Code): plain
 * JavaScript that begins with `export const meta = {...}` (a pure literal:
 * name, description, optional whenToUse and phases) and then orchestrates
 * agents with `agent()`, `parallel()`, `pipeline()`, `phase()` and `log()`.
 *
 * QuickJS WebAssembly runs the orchestration. Each agent runs in its own
 * Codex thread with the session's sandbox. Resumed runs replay cached agent
 * results, so scripts cannot read the clock or generate random numbers.
 */
import type {
  QuickJSDeferredPromise,
  QuickJSHandle,
} from "quickjs-emscripten-core";
import { workflowError, workflowRuntimeFactory } from "./script-runtime";

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases: WorkflowPhaseMeta[];
}

/** Options a script passes to `agent()`. */
export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  isolation?: "worktree";
  agentType?: string;
}

/** What the host does for a script. */
export interface WorkflowHost {
  /** Runs one agent; resolves with its final text, or the parsed object when a schema was given; null when it was skipped or died. */
  agent(prompt: string, options: AgentOptions, phase?: string): Promise<unknown>;
  log(message: string): void;
  phase?(title: string): void;
  loadWorkflow?(name: string): string;
}

export const maxScriptBytes = 512 * 1024;
/** Most items one parallel() or pipeline() call accepts. */
export const maxFanOut = 4096;

const metaPattern =
  /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*export\s+const\s+meta\s*=\s*/;

/** Finds the end of the object literal that starts at `start` (a `{`). */
function literalEnd(source: string, start: number) {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
    } else if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? source.length : close + 1;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("The meta object is not closed.");
}

const text = (value: unknown, field: string, max: number, required = true) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`meta.${field} must be a non-empty string.`);
  return value.trim().slice(0, max);
};

/** Splits a script into its meta and the body that runs. */
export async function parseWorkflowScript(source: string) {
  return parseWorkflowSource(source, await workflowRuntimeFactory());
}

function parseWorkflowSource(
  source: string,
  createRuntime: Awaited<ReturnType<typeof workflowRuntimeFactory>>,
): {
  meta: WorkflowMeta;
  body: string;
} {
  if (typeof source !== "string" || !source.trim())
    throw new Error("The workflow script is empty.");
  if (Buffer.byteLength(source) > maxScriptBytes)
    throw new Error("The workflow script is too long (512 KB at most).");
  const head = metaPattern.exec(source);
  if (!head)
    throw new Error(
      "A workflow script must begin with `export const meta = { name, description, phases }`.",
    );
  const start = head.index + head[0].length;
  if (source[start] !== "{") throw new Error("meta must be an object literal.");
  const end = literalEnd(source, start);
  const literal = source.slice(start, end);
  const sandbox = createRuntime();
  const { vm } = sandbox;
  let raw: any;
  try {
    sandbox.begin();
    raw = sandbox
      .value(vm.evalCode(`JSON.stringify((${literal}))`, "workflow-meta.js"))
      .consume((metadata) => JSON.parse(vm.getString(metadata)));
  } catch (error) {
    throw new Error(
      `meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    vm.dispose();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("meta must be an object literal.");
  const phases: WorkflowPhaseMeta[] = Array.isArray(raw.phases)
    ? raw.phases.slice(0, 24).map((phase: any, i: number) => {
        if (!phase || typeof phase.title !== "string" || !phase.title.trim())
          throw new Error(
            `meta.phases[${i}].title must be a non-empty string.`,
          );
        return {
          title: phase.title.trim().slice(0, 80),
          ...(typeof phase.detail === "string" && phase.detail.trim()
            ? { detail: phase.detail.trim().slice(0, 200) }
            : {}),
          ...(typeof phase.model === "string" && phase.model.trim()
            ? { model: phase.model.trim() }
            : {}),
        };
      })
    : [];
  const meta: WorkflowMeta = {
    name: text(raw.name, "name", 80)!,
    description: text(raw.description, "description", 240)!,
    ...(raw.whenToUse !== undefined
      ? { whenToUse: text(raw.whenToUse, "whenToUse", 400, false) }
      : {}),
    phases,
  };
  let rest = source.slice(end).replace(/^\s*;/, "");
  if (/(^|\n)\s*export\s/.test(rest))
    throw new Error("Only `meta` may be exported.");
  if (/(^|\n)\s*import\s/.test(rest) || /\brequire\s*\(/.test(rest))
    throw new Error("Workflow scripts cannot import modules.");
  return { meta, body: rest };
}

/** Thrown into the script when the run was stopped. */
export class WorkflowStopped extends Error {
  constructor() {
    super("The workflow was stopped.");
  }
}

/** Runs `n` tasks at a time. */
class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

export interface RunScriptOptions {
  args?: unknown;
  initialPhase?: string;
  /** Agents running at once. */
  concurrency: number;
  /** Agents over the whole run. */
  maxAgents: number;
  signal: AbortSignal;
}

/**
 * Runs a script body against a host. Resolves with the script's return
 * value (made plain with JSON); rejects with the script's own error.
 */
export async function runWorkflowScript(
  body: string,
  host: WorkflowHost,
  options: RunScriptOptions,
): Promise<unknown> {
  if (options.signal.aborted) throw new WorkflowStopped();
  const createRuntime = await workflowRuntimeFactory();
  const sandbox = createRuntime();
  const { vm } = sandbox;
  const gate = new Gate(Math.max(1, options.concurrency));
  let started = 0;
  const checkStopped = () => {
    if (options.signal.aborted) throw new WorkflowStopped();
  };
  const pending = new Map<QuickJSDeferredPromise, Promise<void>>();
  let wakeForAbort!: () => void;
  const abort = new Promise<void>((resolve) => {
    wakeForAbort = resolve;
  });
  options.signal.addEventListener("abort", wakeForAbort, { once: true });

  const agent = async (input: unknown) => {
    checkStopped();
    const [prompt, opts, phase] = Array.isArray(input) ? input : [];
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("agent() needs a prompt string.");
    if (++started > options.maxAgents)
      throw new Error(
        `This workflow started more than ${options.maxAgents} agents.`,
      );
    const o = (opts && typeof opts === "object" ? opts : {}) as AgentOptions;
    const clean: AgentOptions = {
      ...(typeof o.label === "string" ? { label: o.label.slice(0, 80) } : {}),
      ...(typeof o.phase === "string" ? { phase: o.phase.slice(0, 80) } : {}),
      ...(o.schema && typeof o.schema === "object" ? { schema: o.schema } : {}),
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      ...(typeof o.effort === "string" ? { effort: o.effort } : {}),
      ...(o.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
      ...(typeof o.agentType === "string" ? { agentType: o.agentType } : {}),
    };
    return gate.run(async () => {
      checkStopped();
      return host.agent(prompt, clean, typeof phase === "string" ? phase : undefined);
    });
  };

  function expose(
    name: string,
    fn: (arg: QuickJSHandle) => QuickJSHandle | void,
  ) {
    vm.newFunction(name, fn).consume((handle) =>
      vm.setProp(vm.global, name, handle),
    );
  }
  function exposeAsync(name: string, fn: (arg: unknown) => Promise<unknown>) {
    expose(name, (arg) => {
      if (!arg || vm.typeof(arg) !== "string")
        throw Error("Invalid workflow arguments.");
      const input: unknown = JSON.parse(vm.getString(arg));
      const result = vm.newPromise();
      const running = Promise.resolve()
        .then(() => {
          checkStopped();
          return fn(input);
        })
        .then((value) => {
          if (result.alive)
            vm.newString(JSON.stringify({ value })).consume(result.resolve);
        })
        .catch((error: unknown) => {
          if (result.alive)
            vm.newError(
              error instanceof Error ? error.message : String(error),
            ).consume(result.reject);
        })
        .finally(() => {
          pending.delete(result);
          if (result.alive) result.dispose();
        });
      pending.set(result, running);
      return result.handle;
    });
  }

  try {
    checkStopped();
    exposeAsync("callAgent", agent);
    expose("workflowLog", (arg) => {
      if (arg && vm.typeof(arg) === "string")
        host.log(vm.getString(arg).slice(0, 2000));
    });
    expose("phase", (arg) => {
      if (!arg || vm.typeof(arg) !== "string") return;
      const title = vm.getString(arg).trim();
      if (title) host.phase?.(title.slice(0, 80));
    });
    const loadWorkflow = host.loadWorkflow;
    if (loadWorkflow) {
      expose("loadSavedWorkflow", (arg) => {
        checkStopped();
        const name = arg && vm.typeof(arg) === "string" ? vm.getString(arg) : "";
        if (!name.trim()) throw Error("workflow() needs a saved workflow name.");
        const { meta, body } = parseWorkflowSource(loadWorkflow(name), createRuntime);
        const phase = JSON.stringify(meta.phases[0]?.title ?? null);
        return sandbox.value(vm.evalCode(
          `(async (args, hooks) => {
            const { agent, log, phase, parallel, pipeline, budget } = hooks(${phase});
            const workflow = async () => { throw Error("Saved workflows can only run one level inline."); };
            return (async () => {\n${body}\n})();
          })`,
          "saved-workflow.js",
        ));
      });
    }
    const args = JSON.stringify(options.args);
    if (args !== undefined)
      vm.newString(args).consume((handle) =>
        vm.setProp(vm.global, "workflowArgs", handle),
      );
    sandbox.begin();
    const result = sandbox.value(
      vm.evalCode(workflowBody(body, options.initialPhase), "workflow.js"),
    );
    try {
      for (;;) {
        sandbox.jobs();
        const state = vm.getPromiseState(result);
        if (state.type === "rejected") throw workflowError(vm, state.error);
        if (state.type === "fulfilled") {
          const data = state.value.consume((value) =>
            JSON.parse(vm.getString(value)),
          );
          return data.result;
        }
        if (!pending.size)
          throw Error(
            "The workflow is waiting for an operation that cannot complete.",
          );
        await Promise.race([abort, ...pending.values()]);
        checkStopped();
        sandbox.begin();
      }
    } finally {
      result.dispose();
    }
  } finally {
    options.signal.removeEventListener("abort", wakeForAbort);
    for (const promise of pending.keys()) if (promise.alive) promise.dispose();
    vm.dispose();
  }
}

function workflowBody(body: string, initialPhase?: string) {
  return `(async () => {
  const encode = JSON.stringify;
  const decode = JSON.parse;
  const args = typeof workflowArgs === "string" ? decode(workflowArgs) : undefined;
  const load = globalThis.loadSavedWorkflow;
  delete globalThis.loadSavedWorkflow;
  const reportPhase = globalThis.phase;
  const budget = Object.freeze({ total: null, spent: () => 0, remaining: () => Infinity });
  const log = (message) => workflowLog(String(message));

  const parallel = async (thunks) => {
    if (!Array.isArray(thunks))
      throw new Error("parallel() takes an array of functions.");
    if (thunks.length > ${maxFanOut})
      throw new Error("parallel() accepts at most ${maxFanOut} items.");
    return Promise.all(thunks.map(async (thunk) => {
      try { return typeof thunk === "function" ? await thunk() : null; }
      catch { return null; }
    }));
  };
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items))
      throw new Error("pipeline() takes an array of items.");
    if (items.length > ${maxFanOut})
      throw new Error("pipeline() accepts at most ${maxFanOut} items.");
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      try {
        for (const stage of stages)
          if (typeof stage === "function") value = await stage(value, item, index);
        return value;
      } catch { return null; }
    }));
  };

  (() => {
    const refuse = () => { throw new EvalError("Code generation from strings is unavailable in workflows."); };
    for (const fn of [function () {}, async function () {}, function* () {}, async function* () {}]) {
      Object.defineProperty(Object.getPrototypeOf(fn), "constructor", { value: refuse });
    }
    globalThis.eval = globalThis.Function = refuse;
    const RealDate = Date;
    const deny = (what) => () => { throw new Error(what + " is unavailable in workflows (it would break resume); pass timestamps in through args."); };
    globalThis.Date = new Proxy(RealDate, {
      construct(target, argList) {
        if (!argList.length) deny("new Date() without arguments")();
        return Reflect.construct(target, argList);
      },
      apply() { return deny("Date()")(); },
      get(target, key) { return key === "now" ? deny("Date.now()") : Reflect.get(target, key); },
    });
    Math.random = deny("Math.random()");
  })();

  const hooks = (initialPhase) => {
    let currentPhase = initialPhase;
    return {
      agent: async (prompt, options) => decode(await callAgent(encode([prompt, options, currentPhase]))).value,
      phase: (title) => {
        if (typeof title !== "string" || !title.trim()) return;
        currentPhase = title.trim().slice(0, 80);
        reportPhase(currentPhase);
      },
      log, parallel, pipeline, budget,
    };
  };
  const { agent, phase } = hooks(${JSON.stringify(initialPhase ?? null)});
  const workflow = load && (async (name, input) => {
    const childInput = decode(encode({ value: input })).value;
    const child = load(name);
    const result = await child(childInput, hooks);
    return decode(encode({ value: result })).value;
  });
  const result = await (async () => {\n${body}\n})();
  return encode({ result });
})()`;
}
