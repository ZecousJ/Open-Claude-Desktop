/**
 * Workflow scripts (the official Workflow tool's format, Claude Code): plain
 * JavaScript that begins with `export const meta = {...}` (a pure literal:
 * name, description, optional whenToUse and phases) and then orchestrates
 * agents with `agent()`, `parallel()`, `pipeline()`, `phase()` and `log()`.
 *
 * The script runs in its own V8 context: no `require`, `process`, file system
 * or network, and `Date.now()`, argless `new Date()` and `Math.random()`
 * throw, so a run can be resumed (cached agent results replay in order). The
 * host gives it agents; everything an agent does happens in its own Codex
 * thread with the session's sandbox.
 */
import vm from "node:vm";

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
  agent(prompt: string, options: AgentOptions): Promise<unknown>;
  log(message: string): void;
  phase(title: string): void;
  /** A saved workflow or script file run inline (one level only). */
  workflow?(
    ref: string | { scriptPath: string },
    args: unknown,
  ): Promise<unknown>;
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
export function parseWorkflowScript(source: string): {
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
  // A pure literal evaluates in an empty context with no globals worth using.
  let raw: any;
  try {
    raw = vm.runInNewContext(`(${literal})`, Object.create(null), {
      timeout: 50,
    });
    // Plain data of this realm (the literal's arrays belong to the other one).
    raw = JSON.parse(JSON.stringify(raw ?? null));
  } catch (error) {
    throw new Error(
      `meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  const gate = new Gate(Math.max(1, options.concurrency));
  let started = 0;
  const stopped = () => options.signal.aborted;
  const plain = (value: unknown) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  const agent = async (prompt: unknown, opts: unknown) => {
    if (stopped()) throw new WorkflowStopped();
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
      ...(o.schema && typeof o.schema === "object"
        ? { schema: plain(o.schema) }
        : {}),
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      ...(typeof o.effort === "string" ? { effort: o.effort } : {}),
      ...(o.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
      ...(typeof o.agentType === "string" ? { agentType: o.agentType } : {}),
    };
    return gate.run(async () => {
      if (stopped()) throw new WorkflowStopped();
      return plain(await host.agent(prompt, clean));
    });
  };
  const parallel = async (thunks: unknown) => {
    if (!Array.isArray(thunks))
      throw new Error("parallel() takes an array of functions.");
    if (thunks.length > maxFanOut)
      throw new Error(`parallel() accepts at most ${maxFanOut} items.`);
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return typeof thunk === "function" ? await thunk() : null;
        } catch (error) {
          if (error instanceof WorkflowStopped) throw error;
          return null;
        }
      }),
    );
  };
  const pipeline = async (items: unknown, ...stages: unknown[]) => {
    if (!Array.isArray(items))
      throw new Error("pipeline() takes an array of items.");
    if (items.length > maxFanOut)
      throw new Error(`pipeline() accepts at most ${maxFanOut} items.`);
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        try {
          for (const stage of stages)
            value =
              typeof stage === "function"
                ? await stage(value, item, index)
                : value;
          return value;
        } catch (error) {
          if (error instanceof WorkflowStopped) throw error;
          return null;
        }
      }),
    );
  };
  const context = vm.createContext(
    {
      agent,
      parallel,
      pipeline,
      phase: (title: unknown) => {
        if (typeof title === "string" && title.trim())
          host.phase(title.trim().slice(0, 80));
      },
      log: (message: unknown) => host.log(String(message).slice(0, 2000)),
      args: plain(options.args),
      budget: Object.freeze({
        total: null,
        spent: () => 0,
        remaining: () => Infinity,
      }),
      workflow: host.workflow
        ? async (ref: unknown, args: unknown) =>
            plain(
              await host.workflow!(
                typeof ref === "string"
                  ? ref
                  : { scriptPath: String((ref as any)?.scriptPath ?? "") },
                plain(args),
              ),
            )
        : undefined,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  // Determinism: a resumed run replays the same calls in the same order.
  vm.runInContext(
    `(() => {
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
    })();`,
    context,
  );
  const wrapped = `(async () => {\n${body}\n})()`;
  const script = new vm.Script(wrapped, { filename: "workflow.js" });
  const result = await script.runInContext(context);
  return plain(result);
}
