/**
 * Engine extension registry (S1). Round-two features add to the Codex
 * threads without editing `electron/engine.ts`: each feature package calls
 * `ctx.engine.extensions.add({...})` from its own register function and
 * keeps its logic in its own files (memory, research, browser, computer use,
 * Cowork folders, tool descriptions).
 *
 * What Codex 0.144.1 does with each contribution (tests/spikes, SP):
 * - developer instructions and dynamic tools are fixed at thread/start;
 *   resume and fork ignore new ones, and fork drops dynamic tools. Text that
 *   must follow later changes belongs in `turnContext` (turn/start
 *   `additionalContext`, kept in the history as a developer message).
 * - per-thread MCP servers are not persisted: the engine passes them again
 *   on every start, resume and fork, reloads a loaded thread whose set
 *   changed, and after a fork unsubscribes and resumes it so their tools come
 *   back. Known OpenAI models reach MCP tools only through `tool_search`, so
 *   tool descriptions should read well to a keyword search.
 * - turn/start `sandboxPolicy.writableRoots` widens the sandbox for that turn
 *   and later ones; the engine sends the full policy on every turn once any
 *   extension contributes roots, so a narrower list takes roots away again.
 */
import type { ApprovalPolicy } from "../../shared/sandbox-policy";
import path from "node:path";
import type { ClientPolicy } from "../../shared/client-policy";
import type {
  CodeSandbox,
  Conversation,
  Item,
  Mode,
  Project,
  Provider,
  Settings,
  Turn,
} from "../../shared/types";
import type {
  ToolDescriptionEvent,
  WebSourcesEvent,
} from "../../shared/gateway-signals";

/** Where a feature's developer instructions go, after the project's own. */
export const instructionOrder = Object.freeze({
  /** R3: the `<user_memory>` block. */
  memory: 100,
  /** R45: Research instructions. */
  research: 200,
  /** Anything else (browser, computer use, Cowork folders). */
  feature: 300,
});

/** What an extension is told about the conversation's next turn. */
export interface EngineTurnContext {
  /** Read-only view; change conversations only through the engine's methods. */
  conversation: Readonly<Conversation>;
  mode: Mode;
  provider: Provider;
  model: string;
  project?: Project;
  policy: ClientPolicy;
  settings: Settings;
  /** The effective sandbox of the turn ("read-only", "workspace-write", …). */
  sandbox: CodeSandbox;
  /** The turn's approval policy (Code: Local sandbox and Strict sandbox mode). */
  approvalPolicy?: ApprovalPolicy;
  /**
   * The local gateway of the engine running the turn (each space's engine
   * has its own); undefined while it is stopped.
   */
  gatewayUrl?: string;
}

/** A function or namespace tool the app answers (Codex `DynamicToolSpec`). */
export type DynamicToolSpec =
  | {
      type: "function";
      name: string;
      description: string;
      inputSchema: unknown;
      deferLoading?: boolean;
    }
  | {
      type: "namespace";
      name: string;
      description: string;
      tools: {
        type?: "function";
        name: string;
        description: string;
        inputSchema: unknown;
        deferLoading?: boolean;
      }[];
    };

/** Codex `item/tool/call`, with the conversation it belongs to. */
export interface DynamicToolCall {
  conversation: Conversation;
  /** The turn the call belongs to, when the engine knows it. */
  turn?: Turn;
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
  /** Publishes changes the handler made to the conversation or turn. */
  changed(): void;
}

/** Codex `DynamicToolCallResponse`. */
export interface DynamicToolResult {
  contentItems: (
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  )[];
  success: boolean;
}

/**
 * An MCP server the app provides, enabled per thread. `url` servers are
 * streamable HTTP (R8 browser); `command` servers are stdio (R10 computer
 * use, R3's MCP fallback). Tokens go through `env` (app-server environment,
 * named by `bearerTokenEnvVar`) or per-thread `httpHeaders`, which Codex
 * does not write to disk.
 */
export interface BuiltinMcpServer {
  /** The Codex server name; must be one the extension reserves. */
  name: string;
  url?: string;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Environment of a stdio server's process (per thread). */
  env?: Record<string, string>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  /**
   * "approve" skips Codex's own approval prompt (the server asks through
   * elicitation itself); "auto" and "prompt" let Codex ask first.
   */
  defaultToolsApprovalMode?: "approve" | "auto" | "prompt";
}

/** A gateway signal and the conversation it concerns, if the engine knows it. */
export interface GatewaySignalContext {
  /** The conversation whose current thread made the request. */
  conversation?: Conversation;
  /** For a child agent's thread: the conversation that started the agent. */
  parent?: Conversation;
  /** The turn a web source was written to. */
  turn?: Turn;
}

export type GatewaySignalEvent =
  | { type: "toolDescription"; event: ToolDescriptionEvent }
  | { type: "webSources"; event: WebSourcesEvent };

export interface EngineExtension {
  /** Unique id; also the `additionalContext` key prefix. */
  id: string;
  /** Also contribute to incognito chats (default: no contribution at all). */
  incognito?: boolean;
  /** Sort key for developer instructions (see `instructionOrder`). */
  order?: number;
  /** MCP server names this extension owns; user servers with these names are not started. */
  reservedMcpServerNames?: readonly string[];
  /** Refuses a send by throwing (policy, model support); runs before anything starts. */
  beforeSend?(ctx: EngineTurnContext): void;
  /** Text for the thread's developer instructions (fixed at thread/start). */
  developerInstructions?(ctx: EngineTurnContext): string | undefined;
  /** Text added to this turn only, as `additionalContext[<id>.<key>]`. */
  turnContext?(ctx: EngineTurnContext): Record<string, string> | undefined;
  prepareTurn?(ctx: EngineTurnContext): Promise<void>;
  /** Tools the app answers (fixed at thread/start; lost on retry/edit branches). */
  dynamicTools?(ctx: EngineTurnContext): DynamicToolSpec[] | undefined;
  /**
   * Answers a dynamic tool call; undefined when the tool is not this
   * extension's. A handler must check the policy itself: a thread keeps its
   * tools after the feature is turned off.
   */
  handleDynamicTool?(
    call: DynamicToolCall,
  ): DynamicToolResult | undefined | Promise<DynamicToolResult | undefined>;
  /**
   * Per-thread MCP servers. Keep them stable (tokens included): a loaded
   * thread whose servers change is unloaded and resumed at its next send.
   */
  builtinMcpServers?(ctx: EngineTurnContext): BuiltinMcpServer[] | undefined;
  /**
   * Environment of the app-server process (for `bearerTokenEnvVar`). Names
   * must contain TOKEN or SECRET (others are ignored), which keeps them out of
   * the commands the agent runs. Must be stable: a change restarts the agent
   * at the next idle send.
   */
  processEnv?(): Record<string, string> | undefined;
  /** Codex config for the whole app-server (`-c`); a change restarts it when idle. */
  appServerConfig?(): Record<string, unknown> | undefined;
  /** Codex config overrides for this conversation's thread. */
  threadConfigOverrides?(
    ctx: EngineTurnContext,
  ): Record<string, unknown> | undefined;
  /** Extra writable folders for a workspace-write turn (absolute paths). */
  turnSandboxExtras?(ctx: EngineTurnContext): string[] | undefined;
  /** Told about every gateway signal after the engine has applied it. */
  onGatewaySignal?(
    signal: GatewaySignalEvent,
    target: GatewaySignalContext,
  ): void;
  /**
   * A turn of a routed conversation finished (any status). `changed`
   * publishes what the hook writes to the conversation later (after an
   * await); a hook that changes it at once need not call it.
   */
  onTurnCompleted?(
    conversation: Conversation,
    turn: Turn,
    changed: () => void,
  ): void;
  /**
   * The item Codex reported, as the engine is about to record it in the
   * conversation; returns a replacement (for example with image data the
   * app keeps elsewhere swapped for a reference) or undefined to keep it.
   */
  recordItem?(
    item: Item,
    conversation: Readonly<Conversation>,
  ): Item | undefined;
}

const extensionId = /^[a-z][a-z0-9_-]{0,63}$/;
const mcpName = /^[a-zA-Z0-9_-]{1,64}$/;
/** Only secret-named variables: the agent keeps *TOKEN* and *SECRET* out of commands. */
const envName = /^(?=[A-Z0-9_]*(TOKEN|SECRET))[A-Z_][A-Z0-9_]{0,127}$/;
const contextKey = /^[a-z][a-z0-9_-]{0,63}$/;
/** Most extra writable folders one turn gets. */
const maxWritableRoots = 32;
/**
 * Codex config an extension never sets: the gateway and its key, the
 * sandbox and approvals, secret filtering, and MCP servers (which go through
 * `builtinMcpServers` under reserved names, or the administrator's
 * allowlist).
 */
export const guardedConfigKeys: readonly string[] = Object.freeze([
  "model_provider",
  "model_providers",
  "mcp_servers",
  "shell_environment_policy",
  "sandbox_mode",
  "sandbox_workspace_write",
  "approval_policy",
  "approvals_reviewer",
  "windows",
  "profile",
  "profiles",
  "experimental_bearer_token",
  "chatgpt_base_url",
  "openai_base_url",
]);
/** Whether a dotted config key is, contains or lies inside another. */
export function configKeysOverlap(a: string, b: string) {
  return a === b || a.startsWith(b + ".") || b.startsWith(a + ".");
}
/** The config without guarded keys (and without any key in `also`). */
function unguarded(
  label: string,
  config: Record<string, unknown>,
  also: readonly string[] = [],
) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (
      [...guardedConfigKeys, ...also].some((guarded) =>
        configKeysOverlap(key, guarded),
      )
    ) {
      console.error(`Engine extension ${label} may not set ${key}.`);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function tolerant<T>(label: string, run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    console.error(
      `Engine extension ${label} failed:`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

/**
 * The registry the engine consults. Contributions are collected in
 * registration order; a hook that throws is logged and skipped (except
 * `beforeSend`, whose error refuses the send).
 */
export class EngineExtensions {
  private entries: EngineExtension[] = [];
  /** Registers an extension; returns the function that removes it. */
  add(extension: EngineExtension): () => void {
    if (!extensionId.test(extension.id))
      throw new Error(`Invalid engine extension id: ${extension.id}`);
    if (this.entries.some((entry) => entry.id === extension.id))
      throw new Error(
        `Engine extension ${extension.id} is already registered.`,
      );
    for (const name of extension.reservedMcpServerNames ?? []) {
      if (!mcpName.test(name))
        throw new Error(`Invalid MCP server name: ${name}`);
      if (this.reservedMcpServerNames().has(name))
        throw new Error(`MCP server name ${name} is already reserved.`);
    }
    this.entries.push(extension);
    return () => {
      this.entries = this.entries.filter((entry) => entry !== extension);
    };
  }
  list(): readonly EngineExtension[] {
    return this.entries;
  }
  has(id: string) {
    return this.entries.some((entry) => entry.id === id);
  }
  /** Extensions that contribute to this conversation. */
  private active(ctx: EngineTurnContext) {
    return this.entries.filter(
      (entry) => !ctx.conversation.incognito || entry.incognito,
    );
  }
  reservedMcpServerNames(): Set<string> {
    return new Set(
      this.entries.flatMap((entry) => entry.reservedMcpServerNames ?? []),
    );
  }
  beforeSend(ctx: EngineTurnContext) {
    for (const entry of this.active(ctx)) entry.beforeSend?.(ctx);
  }
  async prepareTurn(ctx: EngineTurnContext) {
    await Promise.all(
      this.active(ctx).map((entry) => entry.prepareTurn?.(ctx)),
    );
  }
  /** Instruction blocks in `order`, then registration order. */
  developerInstructions(ctx: EngineTurnContext): string[] {
    return this.active(ctx)
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          (a.entry.order ?? instructionOrder.feature) -
            (b.entry.order ?? instructionOrder.feature) || a.index - b.index,
      )
      .map(({ entry }) =>
        tolerant(`${entry.id}.developerInstructions`, () =>
          entry.developerInstructions?.(ctx),
        ),
      )
      .filter(
        (text): text is string => typeof text === "string" && !!text.trim(),
      )
      .map((text) => text.trim());
  }
  /** turn/start `additionalContext`, or undefined when empty. */
  turnContext(
    ctx: EngineTurnContext,
  ): Record<string, { value: string; kind: "application" }> | undefined {
    const context: Record<string, { value: string; kind: "application" }> = {};
    for (const entry of this.active(ctx)) {
      const values = tolerant(`${entry.id}.turnContext`, () =>
        entry.turnContext?.(ctx),
      );
      for (const [key, value] of Object.entries(values ?? {}))
        if (contextKey.test(key) && typeof value === "string" && value.trim())
          context[`${entry.id}.${key}`] = { value, kind: "application" };
    }
    return Object.keys(context).length ? context : undefined;
  }
  /** Dynamic tools; a later tool with an already used name is dropped. */
  dynamicTools(ctx: EngineTurnContext): DynamicToolSpec[] {
    const names = new Set<string>();
    const tools: DynamicToolSpec[] = [];
    for (const entry of this.active(ctx))
      for (const tool of tolerant(`${entry.id}.dynamicTools`, () =>
        entry.dynamicTools?.(ctx),
      ) ?? []) {
        if (!tool || typeof tool.name !== "string" || names.has(tool.name))
          continue;
        names.add(tool.name);
        tools.push(tool);
      }
    return tools;
  }
  /** The first handler that claims the call answers it. */
  async handleDynamicTool(call: DynamicToolCall): Promise<DynamicToolResult> {
    for (const entry of this.entries) {
      if (call.conversation.incognito && !entry.incognito) continue;
      if (!entry.handleDynamicTool) continue;
      try {
        const result = await entry.handleDynamicTool(call);
        if (result) return result;
      } catch (error) {
        return {
          contentItems: [
            {
              type: "inputText",
              text: error instanceof Error ? error.message : "The tool failed.",
            },
          ],
          success: false,
        };
      }
    }
    return {
      contentItems: [
        { type: "inputText", text: `The tool ${call.tool} isn't available.` },
      ],
      success: false,
    };
  }
  /** Per-thread MCP servers, only under names their extension reserved. */
  builtinMcpServers(ctx: EngineTurnContext): BuiltinMcpServer[] {
    const servers: BuiltinMcpServer[] = [];
    const used = new Set<string>();
    for (const entry of this.active(ctx)) {
      const reserved = new Set(entry.reservedMcpServerNames ?? []);
      for (const server of tolerant(`${entry.id}.builtinMcpServers`, () =>
        entry.builtinMcpServers?.(ctx),
      ) ?? []) {
        if (!reserved.has(server.name) || used.has(server.name)) continue;
        if (!server.url === !server.command) continue;
        used.add(server.name);
        servers.push(server);
      }
    }
    return servers;
  }
  /** The app-server environment extensions add (valid variable names only). */
  processEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of this.entries)
      for (const [key, value] of Object.entries(
        tolerant(`${entry.id}.processEnv`, () => entry.processEnv?.()) ?? {},
      ))
        if (envName.test(key) && typeof value === "string") env[key] = value;
    return env;
  }
  /** App-server config from extensions, without guarded keys. */
  appServerConfig(): Record<string, unknown> {
    return Object.assign(
      {},
      ...this.entries.map((entry) =>
        unguarded(
          `${entry.id}.appServerConfig`,
          tolerant(`${entry.id}.appServerConfig`, () =>
            entry.appServerConfig?.(),
          ) ?? {},
        ),
      ),
    );
  }
  /**
   * Thread config from extensions, without guarded keys. Web search stays
   * off when the administrator's policy turns it off.
   */
  threadConfigOverrides(ctx: EngineTurnContext): Record<string, unknown> {
    const also = ctx.policy.webSearch ? [] : ["web_search", "tools.web_search"];
    return Object.assign(
      {},
      ...this.active(ctx).map((entry) =>
        unguarded(
          `${entry.id}.threadConfigOverrides`,
          tolerant(`${entry.id}.threadConfigOverrides`, () =>
            entry.threadConfigOverrides?.(ctx),
          ) ?? {},
          also,
        ),
      ),
    );
  }
  /** Whether any extension can widen the sandbox (the policy is then always sent). */
  widensSandbox() {
    return this.entries.some((entry) => entry.turnSandboxExtras);
  }
  /** Extra writable folders: absolute, normalized, without duplicates. */
  turnSandboxExtras(ctx: EngineTurnContext): string[] {
    const roots = new Set<string>();
    for (const entry of this.active(ctx))
      for (const root of tolerant(`${entry.id}.turnSandboxExtras`, () =>
        entry.turnSandboxExtras?.(ctx),
      ) ?? [])
        if (typeof root === "string" && root && path.isAbsolute(root))
          roots.add(path.normalize(root));
    return [...roots].slice(0, maxWritableRoots);
  }
  gatewaySignal(signal: GatewaySignalEvent, target: GatewaySignalContext) {
    for (const entry of this.entries)
      tolerant(`${entry.id}.onGatewaySignal`, () =>
        entry.onGatewaySignal?.(signal, target),
      );
  }
  /** The item to record after every extension's `recordItem`. */
  recordItem(conversation: Conversation, item: Item): Item {
    let current = item;
    for (const entry of this.entries) {
      if (conversation.incognito && !entry.incognito) continue;
      if (!entry.recordItem) continue;
      const replaced = tolerant(`${entry.id}.recordItem`, () =>
        entry.recordItem?.(current, conversation),
      );
      if (
        replaced &&
        typeof replaced === "object" &&
        replaced.id === current.id &&
        replaced.type === current.type
      )
        current = replaced;
    }
    return current;
  }
  turnCompleted(
    conversation: Conversation,
    turn: Turn,
    changed: () => void = () => {},
  ) {
    for (const entry of this.entries) {
      if (conversation.incognito && !entry.incognito) continue;
      tolerant(`${entry.id}.onTurnCompleted`, () =>
        entry.onTurnCompleted?.(conversation, turn, changed),
      );
    }
  }
}

/**
 * Item fields that arrived before their item (a gateway signal is usually
 * read before Codex reports the item). Bounded: the oldest entry goes first.
 */
export interface ItemPatch {
  /** Fields to set. */
  fields: Partial<Item>;
  /** Item types the patch may apply to. */
  types: readonly string[];
  /** Replace fields the item already has (default: keep them). */
  overwrite?: boolean;
  /**
   * The item must pass this check (for example, its text matches what the
   * fields refer to). A pending patch that fails waits for the next update
   * of the item and is dropped once the item completes.
   */
  accepts?: (item: Item) => boolean;
}

/** Codex config (`mcp_servers.<name>.*`) for per-thread MCP servers. */
export function builtinMcpConfig(
  servers: BuiltinMcpServer[],
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const server of servers) {
    const key = (field: string) => `mcp_servers.${server.name}.${field}`;
    if (server.url) {
      config[key("url")] = server.url;
      if (server.bearerTokenEnvVar)
        config[key("bearer_token_env_var")] = server.bearerTokenEnvVar;
      if (server.httpHeaders) config[key("http_headers")] = server.httpHeaders;
    } else if (server.command) {
      config[key("command")] = server.command;
      if (server.args) config[key("args")] = server.args;
      if (server.env) config[key("env")] = server.env;
    }
    if (server.startupTimeoutSec !== undefined)
      config[key("startup_timeout_sec")] = server.startupTimeoutSec;
    if (server.toolTimeoutSec !== undefined)
      config[key("tool_timeout_sec")] = server.toolTimeoutSec;
    if (server.defaultToolsApprovalMode)
      config[key("default_tools_approval_mode")] =
        server.defaultToolsApprovalMode;
  }
  return config;
}
