import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  LocalMcpCandidate,
  LocalMcpDiscovery,
  LocalMcpImportRequest,
  LocalMcpImportResult,
} from "../../shared/settings-mcp-api";
import {
  mcpConfigText,
  parseMcpConfig,
  reservedMcpServerName,
} from "./mcp-config-file";
import { mcpSecrets, redactMcpText } from "./mcp-connection-logs";
import { localMcpImportLimit } from "../../shared/settings-mcp-api";

interface Source {
  name: string;
  path: string;
}
interface Entry {
  id: string;
  name: string;
  source: string;
  config?: Record<string, unknown>;
  reason?: string;
}
const maxSourceBytes = 1024 * 1024;
const maxEntries = 100;
const expired = "This review expired. Check for MCP servers again.";

/** Fixed supported locations only. The renderer cannot supply a file path. */
export function localMcpSources(
  home = os.homedir(),
  platform = process.platform,
): Source[] {
  const desktop =
    platform === "darwin"
      ? path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        )
      : platform === "win32"
        ? path.join(
            process.env.APPDATA || path.join(home, "AppData", "Roaming"),
            "Claude",
            "claude_desktop_config.json",
          )
        : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    { name: "Claude Desktop", path: desktop },
    { name: "Claude Code (user)", path: path.join(home, ".claude.json") },
    { name: "Cursor (user)", path: path.join(home, ".cursor", "mcp.json") },
  ];
}

/** Only configurations whose semantics Claudex preserves are offered. */
function supportedEntry(name: string, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("This server configuration is not supported.");
  const config = raw as Record<string, unknown>;
  const allowed = new Set(["type", "command", "args", "env", "cwd", "enabled"]);
  if (
    Object.keys(config).some((key) => !allowed.has(key)) ||
    (config.type !== undefined && config.type !== "stdio")
  )
    throw Error(
      "Only local stdio servers with command, arguments, environment and optional working directory are supported.",
    );
  if (
    typeof config.command !== "string" ||
    !config.command.trim() ||
    config.command.length > 4096
  )
    throw Error("This server needs a valid local command.");
  if (
    config.args !== undefined &&
    (!Array.isArray(config.args) ||
      config.args.length > 128 ||
      config.args.some((arg) => typeof arg !== "string" || arg.length > 8192))
  )
    throw Error("This server has unsupported arguments.");
  if (
    config.cwd !== undefined &&
    (typeof config.cwd !== "string" || !path.isAbsolute(config.cwd))
  )
    throw Error("The working directory must be an absolute path.");
  if (
    config.env !== undefined &&
    (!config.env ||
      typeof config.env !== "object" ||
      Array.isArray(config.env) ||
      Object.entries(config.env).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string",
      ))
  )
    throw Error("This server has unsupported environment variables.");
  const { type: _type, ...entry } = config;
  parseMcpConfig(mcpConfigText({ [name]: entry }));
  return structuredClone(entry);
}

function canonical(config: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    return value;
  };
  const entry =
    config && typeof config === "object" && !Array.isArray(config)
      ? Object.fromEntries(
          Object.entries(config).filter(
            ([key]) => key !== "enabled" && key !== "type",
          ),
        )
      : config;
  return JSON.stringify(normalize(entry));
}

export class LocalMcpReview {
  private review?: {
    token: string;
    owner: string;
    at: number;
    entries: Entry[];
  };
  constructor(
    private host: {
      owner(): string;
      current(): Record<string, unknown>;
      managedNames(): readonly string[];
      allowed(name: string, config: unknown): boolean;
      update(servers: Record<string, unknown>): void;
      sources?: () => Source[];
      now?: () => number;
    },
  ) {}
  private state(
    entry: Entry,
    current: Record<string, unknown>,
  ): Pick<LocalMcpCandidate, "state" | "reason"> {
    if (
      reservedMcpServerName(entry.name) ||
      this.host
        .managedNames()
        .some((name) => name.toLowerCase() === entry.name.toLowerCase())
    )
      return { state: "managed", reason: "This name is managed by Claudex." };
    if (!entry.config) return { state: "unsupported", reason: entry.reason };
    const collision = Object.keys(current).find(
      (name) => name.toLowerCase() === entry.name.toLowerCase(),
    );
    if (
      collision &&
      (current[collision] as { claudex_extension?: unknown } | undefined)
        ?.claudex_extension
    )
      return {
        state: "managed",
        reason: "This name is managed by an installed extension.",
      };
    if (collision)
      return canonical(current[collision]) === canonical(entry.config)
        ? { state: "duplicate", reason: "Already set up." }
        : {
            state: "name-in-use",
            reason:
              "This name is already in use. Existing configuration will be preserved.",
          };
    if (
      Object.values(current).some(
        (config) => canonical(config) === canonical(entry.config),
      )
    )
      return {
        state: "duplicate",
        reason: "Already set up under another name.",
      };
    if (!this.host.allowed(entry.name, entry.config))
      return {
        state: "managed",
        reason: "Your administrator does not allow this server.",
      };
    return { state: "available" };
  }
  async discover(): Promise<LocalMcpDiscovery> {
    this.review = undefined;
    const owner = this.host.owner();
    const entries: Entry[] = [];
    const sources: LocalMcpDiscovery["sources"] = [];
    for (const source of (this.host.sources ?? localMcpSources)()) {
      let file;
      try {
        file = await fs.open(
          source.path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxSourceBytes)
          throw Error("unsupported source");
        // Bound the actual read as well: a file may grow after stat().
        const bytes = Buffer.alloc(maxSourceBytes + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > maxSourceBytes) throw Error("source too large");
        const data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw Error("unsupported source");
        const servers = data?.mcpServers;
        if (
          servers !== undefined &&
          (!servers || typeof servers !== "object" || Array.isArray(servers))
        )
          throw Error("unsupported source");
        const pairs = Object.entries(servers ?? {});
        if (pairs.length + entries.length > maxEntries)
          throw Error("too many servers");
        for (const [name, raw] of pairs) {
          const id = randomUUID();
          try {
            entries.push({
              id,
              name,
              source: source.name,
              config: supportedEntry(name, raw),
            });
          } catch (error) {
            entries.push({
              id,
              name: name.slice(0, 128),
              source: source.name,
              reason:
                error instanceof Error
                  ? error.message
                  : "Unsupported configuration.",
            });
          }
        }
        sources.push({ name: source.name, state: "read" });
      } catch (error) {
        sources.push({
          name: source.name,
          state:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing"
              : "error",
          message:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? undefined
              : "Couldn’t read a supported MCP configuration from this source.",
        });
      } finally {
        await file?.close();
      }
    }
    if (owner !== this.host.owner()) throw Error(expired);
    const token = randomUUID();
    this.review = { token, owner, at: (this.host.now ?? Date.now)(), entries };
    const seen: Record<string, unknown> = Object.assign(
      Object.create(null),
      this.host.current(),
    );
    const candidates = entries.map((entry): LocalMcpCandidate => {
      const state = this.state(entry, seen);
      if (state.state === "available") seen[entry.name] = entry.config;
      return {
        id: entry.id,
        name: entry.name,
        source: entry.source,
        ...state,
        preview: entry.config
          ? redactMcpText(
              JSON.stringify(entry.config, null, 2),
              mcpSecrets(entry.config),
            )
          : "",
      };
    });
    return { token, candidates, sources };
  }
  import(request: LocalMcpImportRequest): LocalMcpImportResult {
    const review = this.review;
    if (
      !review ||
      request.token !== review.token ||
      review.owner !== this.host.owner() ||
      (this.host.now ?? Date.now)() - review.at > 10 * 60_000
    )
      throw Error(expired);
    if (
      !request.ids.length ||
      request.ids.length > localMcpImportLimit ||
      new Set(request.ids).size !== request.ids.length
    )
      throw Error("Select valid servers to import.");
    const next: Record<string, unknown> = Object.assign(
      Object.create(null),
      this.host.current(),
    );
    const imported: string[] = [];
    for (const id of request.ids) {
      const entry = review.entries.find((candidate) => candidate.id === id);
      if (!entry || this.state(entry, next).state !== "available")
        throw Error(
          "The selected servers changed or a name is now in use. Check for MCP servers again.",
        );
      next[entry.name] = { ...entry.config, enabled: false };
      imported.push(entry.name);
    }
    parseMcpConfig(mcpConfigText(next));
    this.host.update(next);
    this.review = undefined;
    return { imported, disabled: true };
  }
}
