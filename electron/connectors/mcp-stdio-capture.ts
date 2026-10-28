import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  mcpStdioCaptureEnvironment,
  type McpStdioDescriptor,
  type McpStdioLogSnapshot,
} from "../../shared/mcp-stdio-logs";
import {
  liveMcpLease,
  readPrivateMcpTail,
} from "../../server/mcp-private-log-store";
import { mcpSecrets } from "./mcp-connection-logs";

export interface McpCaptureOwner {
  root: string;
  accountScope: string;
  scope: object;
}
export interface McpStdioCaptureOptions {
  owner(): McpCaptureOwner | undefined;
  currentConfiguration(name: string): unknown;
  helperPath: string;
  node: { executable: string; electron: boolean };
  /** Native-only current configuration strings; failures disable capture. */
  secrets(name: string): string[];
}
type Binding = {
  directory: string;
  owner: string;
  version: string;
  token: string;
  fingerprint: string;
  sourceIdentity: string;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function privateDirectory(root: string, parts: string[]) {
  let current = fs.realpathSync(root);
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_-]+$/.test(part))
      throw Error("Invalid private MCP directory.");
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (
      !fs.lstatSync(current).isDirectory() ||
      fs.lstatSync(current).isSymbolicLink() ||
      fs.realpathSync(current) !== current ||
      (fs.statSync(current).mode & 0o077) !== 0
    )
      throw Error("Private MCP directory unavailable.");
  }
  return current;
}
function atomicPrivate(directory: string, filename: string, value: string) {
  const file = path.join(directory, filename);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("Private MCP file unavailable.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `${filename}-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}
/** One native runtime owner; main must retire it before account/runtime teardown. */
export class McpStdioCapture {
  private active?: McpCaptureOwner;
  private epoch = randomUUID();
  private bindings = new Map<string, Binding>();
  private descriptors = new Map<string, McpStdioDescriptor>();
  private server?: net.Server;
  private socketPath?: string;
  private starting?: Promise<boolean>;
  get ready() {
    this.current();
    try {
      return (
        this.server?.listening === true &&
        !!this.socketPath &&
        fs.lstatSync(this.options.helperPath).isFile() &&
        !fs.lstatSync(this.options.helperPath).isSymbolicLink()
      );
    } catch {
      return false;
    }
  }
  start(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    const starting = this.openBootstrap().catch(() => false);
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    return starting;
  }
  private async openBootstrap(): Promise<boolean> {
    const owner = this.current();
    if (!owner || process.platform === "win32") return false;
    try {
      if (
        !path.isAbsolute(this.options.helperPath) ||
        !fs.lstatSync(this.options.helperPath).isFile() ||
        fs.lstatSync(this.options.helperPath).isSymbolicLink()
      )
        return false;
      fs.accessSync(this.options.node.executable, fs.constants.X_OK);
    } catch {
      return false;
    }
    const epoch = this.epoch;
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cx-mcp-")),
    );
    const socketPath = path.join(directory, "rpc.sock");
    const cleanup = () => {
      try {
        fs.rmSync(directory, { recursive: true });
      } catch {}
    };
    if (Buffer.byteLength(socketPath) > 100) {
      cleanup();
      return false;
    }
    const server = net.createServer((socket) => {
      let request = "";
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", (chunk: string) => {
        request += chunk;
        if (Buffer.byteLength(request) > 4096) return socket.destroy();
        if (!request.includes("\n")) return;
        try {
          const address = JSON.parse(request.trim());
          const current = this.current();
          const pair = [...this.bindings.entries()].find(
            ([, binding]) =>
              binding.token === address.token &&
              binding.owner === address.owner &&
              binding.version === address.version,
          );
          if (!current || current.scope !== owner.scope || !pair)
            return socket.destroy();
          const [name, binding] = pair;
          const source = this.options.currentConfiguration(name);
          if (
            source === undefined ||
            hash(JSON.stringify(source)) !== binding.sourceIdentity ||
            !liveMcpLease(binding)
          )
            return socket.destroy();
          const descriptor = this.descriptors.get(binding.token);
          if (!descriptor) return socket.destroy();
          socket.removeAllListeners("data");
          socket.end(JSON.stringify(descriptor));
        } catch {
          socket.destroy();
        }
      });
    });
    const opened = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(socketPath, () => resolve(true));
    });
    const latestOwner = this.options.owner();
    if (
      !opened ||
      this.epoch !== epoch ||
      !latestOwner ||
      latestOwner.scope !== owner.scope ||
      latestOwner.root !== owner.root ||
      latestOwner.accountScope !== owner.accountScope
    ) {
      server.close(cleanup);
      return false;
    }
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      server.close(cleanup);
      return false;
    }
    server.unref();
    this.server = server;
    this.socketPath = socketPath;
    return true;
  }
  constructor(private options: McpStdioCaptureOptions) {}
  private current() {
    const next = this.options.owner();
    if (next && !this.active) {
      this.active = { ...next };
      return next;
    }
    if (
      !next ||
      !this.active ||
      next.scope !== this.active.scope ||
      next.root !== this.active.root ||
      next.accountScope !== this.active.accountScope
    ) {
      this.retire();
      this.active = next ? { ...next } : undefined;
    }
    return next;
  }
  /** Invoke after extension resolution, before private metadata is stripped.
   * `originalRunAsNode` is an explicit proof of the MCP child's original value
   * (or absence), required only if this helper uses Electron as Node. */
  launchWrapper(
    name: string,
    entry: Record<string, unknown>,
    originalRunAsNode?: { value?: string },
  ): { entry: Record<string, unknown>; supported: boolean } {
    const owner = this.current();
    const unsupported = () => {
      this.retireServer(name);
      return { entry, supported: false };
    };
    if (
      (!this.bindings.has(name) && this.bindings.size >= 128) ||
      !owner ||
      !this.server?.listening ||
      !this.socketPath ||
      process.platform === "win32" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(name) ||
      typeof entry.command !== "string" ||
      entry.url !== undefined ||
      entry.enabled === false
    )
      return unsupported();
    const args = entry.args ?? [];
    const env = entry.env ?? {};
    if (
      !Array.isArray(args) ||
      !args.every((value) => typeof value === "string") ||
      !env ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      !Object.values(env).every((value) => typeof value === "string") ||
      (entry.cwd !== undefined && typeof entry.cwd !== "string")
    )
      return unsupported();
    const variables = entry.env_vars;
    if (
      variables !== undefined &&
      (!Array.isArray(variables) ||
        !variables.every((value) => typeof value === "string"))
    )
      return unsupported();
    if (
      Object.hasOwn(env, mcpStdioCaptureEnvironment) ||
      (variables as string[] | undefined)?.includes(mcpStdioCaptureEnvironment)
    )
      return unsupported();
    const explicitRunAsNode = (env as Record<string, string>)
      .ELECTRON_RUN_AS_NODE;
    if (
      this.options.node.electron &&
      explicitRunAsNode === undefined &&
      !originalRunAsNode
    )
      return unsupported();
    try {
      if (
        !path.isAbsolute(this.options.helperPath) ||
        !path.isAbsolute(this.options.node.executable)
      )
        return unsupported();
      fs.accessSync(this.options.node.executable, fs.constants.X_OK);
      const helper = fs.lstatSync(this.options.helperPath);
      if (!helper.isFile() || helper.isSymbolicLink()) return unsupported();
      const secrets = [
        ...new Set([...mcpSecrets(entry), ...this.options.secrets(name)]),
      ];
      if (
        !secrets.every(
          (value) => typeof value === "string" && value.length <= 65536,
        )
      )
        return unsupported();
      const source = this.options.currentConfiguration(name);
      if (
        !source ||
        typeof source !== "object" ||
        typeof (source as Record<string, unknown>).command !== "string" ||
        (source as Record<string, unknown>).url !== undefined ||
        (source as Record<string, unknown>).enabled === false
      )
        return unsupported();
      const sourceIdentity = hash(JSON.stringify(source));
      const fingerprint = hash(
        JSON.stringify([
          name,
          entry,
          secrets,
          sourceIdentity,
          this.options.node,
          this.options.node.electron
            ? { value: explicitRunAsNode ?? originalRunAsNode?.value }
            : undefined,
        ]),
      );
      let binding = this.bindings.get(name);
      if (binding?.fingerprint !== fingerprint) {
        this.retireServer(name);
        const directory = privateDirectory(owner.root, [
          "mcp-stdio-logs",
          hash(owner.accountScope),
          hash(name),
          fingerprint,
        ]);
        // A server retains only one immutable configuration version (five
        // rotated files), including across clean runtime restarts.
        for (const sibling of fs.readdirSync(path.dirname(directory))) {
          if (sibling === fingerprint || !/^[a-f0-9]{64}$/.test(sibling))
            continue;
          const old = path.join(path.dirname(directory), sibling);
          if (
            fs.lstatSync(old).isDirectory() &&
            !fs.lstatSync(old).isSymbolicLink() &&
            fs.realpathSync(old) === old
          )
            fs.rmSync(old, { recursive: true });
        }
        binding = {
          directory,
          owner: this.epoch,
          version: fingerprint,
          token: randomUUID(),
          fingerprint,
          sourceIdentity,
        };
        atomicPrivate(
          directory,
          "lease.json",
          JSON.stringify({
            ...binding,
            directory: undefined,
            fingerprint: undefined,
            active: true,
          }),
        );
        this.bindings.set(name, binding);
      }
      const descriptor: McpStdioDescriptor = {
        directory: binding.directory,
        owner: binding.owner,
        version: binding.version,
        token: binding.token,
        command: entry.command,
        args: [...args] as string[],
        // The app-server has already applied entry.cwd to this wrapper.
        environment: { ...env } as Record<string, string>,
        secrets,
        ...(this.options.node.electron
          ? {
              restoreRunAsNode: {
                value: explicitRunAsNode ?? originalRunAsNode?.value,
              },
            }
          : {}),
      };
      const serialized = JSON.stringify(descriptor);
      if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) return unsupported();
      this.descriptors.set(binding.token, descriptor);
      const address = JSON.stringify({
        socketPath: this.socketPath,
        owner: binding.owner,
        version: binding.version,
        token: binding.token,
      });
      return {
        supported: true,
        entry: {
          ...entry,
          command: this.options.node.executable,
          args: [this.options.helperPath],
          env: {
            ...(this.options.node.electron
              ? { ELECTRON_RUN_AS_NODE: "1" }
              : {}),
            [mcpStdioCaptureEnvironment]: address,
          },
        },
      };
    } catch {
      return unsupported();
    }
  }
  read(name: string): McpStdioLogSnapshot {
    this.current();
    const binding = this.bindings.get(name);
    if (!binding)
      return {
        source: "stdio-stderr",
        availability: "unsupported",
        lines: [],
        truncated: false,
      };
    let sourceIdentity: string | undefined;
    try {
      const source = this.options.currentConfiguration(name);
      if (source !== undefined) sourceIdentity = hash(JSON.stringify(source));
    } catch {}
    if (sourceIdentity !== binding.sourceIdentity) {
      // A read never terminates an active MCP operation. Explicit lifecycle
      // retirement (or the next launch) invalidates the old process lease.
      return {
        source: "stdio-stderr",
        availability: "unsupported",
        lines: [],
        truncated: false,
      };
    }
    if (!liveMcpLease(binding))
      return {
        source: "stdio-stderr",
        availability: "unavailable",
        lines: [],
        truncated: false,
      };
    try {
      let state = "pending";
      const file = path.join(binding.directory, "state");
      if (fs.existsSync(file)) {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).size > 64)
          throw Error("Invalid capture status.");
        state = fs.readFileSync(file, "utf8");
      }
      return {
        source: "stdio-stderr",
        availability:
          state === "capturing" || state === "stopped"
            ? "available"
            : state === "failed"
              ? "unavailable"
              : "pending",
        ...readPrivateMcpTail(binding.directory),
      };
    } catch {
      return {
        source: "stdio-stderr",
        availability: "unavailable",
        lines: [],
        truncated: false,
      };
    }
  }
  retireServer(name: string) {
    const binding = this.bindings.get(name);
    this.bindings.delete(name);
    if (binding) this.descriptors.delete(binding.token);
    if (!binding) return;
    try {
      if (!liveMcpLease(binding)) return;
      atomicPrivate(
        binding.directory,
        "lease.json",
        JSON.stringify({
          owner: binding.owner,
          version: binding.version,
          token: binding.token,
          active: false,
        }),
      );
      // Redacted files persist for the same configuration. A later launch
      // replaces the lease and prunes other versions; retired clients cannot read.
    } catch {
      /* A retired source is never returned by read(). */
    }
  }
  retire() {
    this.starting = undefined;
    const server = this.server;
    const socketPath = this.socketPath;
    this.server = undefined;
    this.socketPath = undefined;
    if (server && socketPath)
      server.close(() => {
        try {
          fs.rmSync(path.dirname(socketPath), { recursive: true });
        } catch {}
      });
    for (const name of this.bindings.keys()) this.retireServer(name);
    this.active = undefined;
    this.epoch = randomUUID();
  }
}
