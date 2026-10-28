import {
  commitNativeMcpServers,
  clearNativeExtensionMirrorReceipt,
} from "./native-extension-mirror";
import fs from "node:fs";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { StorageCipher } from "../engine/provider-credentials";
import {
  ExtensionLifecycle,
  registerDesktopExtensionHandlers,
  type ExtensionLifecycleOwner,
} from "./extension-lifecycle";
import { McpStdioCapture } from "./mcp-stdio-capture";
import { mcpConfigText } from "./mcp-config-file";
import { settingsRefusal } from "../../shared/client-policy";
import { preference } from "../../shared/settings-extras";

interface NativeExtensionOptions {
  ctx: AppContext;
  cipher: StorageCipher;
  helperPath: string;
  node: { executable: string; electron: boolean };
}
type Lease = {
  scope: object;
  account: NonNullable<AppContext["activeAccount"]>;
  store: AppContext["store"];
  engine: AppContext["engine"];
  remote: AppContext["remote"];
};

/** Native IPC owns configuration; neither web nor a runner may register this. */
export class NativeExtensionHost {
  readonly lifecycle: ExtensionLifecycle;
  private lease?: Lease;
  private capture?: McpStdioCapture;
  private maintenance?: object;
  constructor(private options: NativeExtensionOptions) {
    const ctx = options.ctx;
    this.lifecycle = new ExtensionLifecycle({
      owner: () => this.owner(),
      cipher: options.cipher,
      runtimeConfiguration: (entry) =>
        Boolean(this.capture?.ready && entry && this.canWrap(entry)),
      update: (servers) => {
        const lease = this.current();
        if (ctx.engines.isBusy())
          throw Error(
            "Wait for the current task to finish before changing extension settings.",
          );
        const next = { ...lease.store.settings, mcpServers: servers };
        const refusal = settingsRefusal(
          lease.store.settings,
          next,
          ctx.policy(),
        );
        if (refusal) throw Error(refusal);
        // This is the commit point. A later history flush or secondary mirror
        // failure must not report that an already committed save failed.
        commitNativeMcpServers(lease.store, servers);
        const previous = this.configured;
        this.configured = servers;
        for (const name of new Set([
          ...Object.keys(servers),
          ...Object.keys(previous),
        ])) {
          if (
            JSON.stringify(servers[name]) !== JSON.stringify(previous[name])
          ) {
            try {
              this.capture?.retireServer(name);
            } catch {
              /* Publication already succeeded. */
            }
          }
        }
        try {
          const file = ctx.mcpConfig?.path;
          if (file) {
            fs.writeFileSync(`${file}.native.tmp`, mcpConfigText(servers), {
              mode: 0o600,
            });
            fs.renameSync(`${file}.native.tmp`, file);
            clearNativeExtensionMirrorReceipt(lease.store.root);
          }
        } catch {
          /* The durable settings pointer remains authoritative. */
        }
        try {
          ctx.settingsChanged();
        } catch {
          /* An observer cannot undo publication. */
        }
      },
      prepareUninstall: async (owner) => {
        const lease = this.current();
        if (owner.scope !== lease.scope || this.maintenance)
          throw Error("The extension changed. Reload it and try again.");
        const maintenance = {};
        this.maintenance = maintenance;
        const release = () => {
          if (this.maintenance === maintenance) this.maintenance = undefined;
        };
        try {
          const engines = ctx.engines.all();
          if (engines.some((engine) => engine.ownBusy()))
            throw Error(
              "Wait for the current task to finish before uninstalling an extension.",
            );
          await Promise.all(engines.map((engine) => engine.quiesceMcp()));
          this.current(lease);
          if (
            ctx.engines.all().some((engine) => engine.rpc || engine.ownBusy())
          )
            throw Error(
              "Wait for the current task to finish before uninstalling an extension.",
            );
          return release;
        } catch (error) {
          release();
          throw error;
        }
      },
    });
    ctx.onAccountDeactivating(() => this.retire());
  }
  private configured: Record<string, unknown> = {};
  private current(expected = this.lease): Lease {
    const ctx = this.options.ctx;
    if (
      !expected ||
      expected !== this.lease ||
      expected.account !== ctx.activeAccount ||
      expected.store !== ctx.store ||
      expected.engine !== ctx.engine ||
      expected.remote !== ctx.remote
    )
      throw Error("This extension is unavailable.");
    return expected;
  }
  private owner(): ExtensionLifecycleOwner {
    const lease = this.current();
    return {
      root: lease.store.root,
      scope: lease.scope,
      servers: lease.store.settings.mcpServers,
      policy: this.options.ctx.policy(),
    };
  }
  private canWrap(entry: Record<string, unknown>) {
    const env = entry.env as Record<string, unknown> | undefined;
    return (
      !this.options.node.electron ||
      typeof env?.ELECTRON_RUN_AS_NODE === "string" ||
      (entry.command === "node" &&
        preference(this.current().store.settings, "extensionBuiltInNode"))
    );
  }
  async activate() {
    this.retire();
    const ctx = this.options.ctx;
    if (!ctx.activeAccount) return;
    const lease = (this.lease = {
      scope: {},
      account: ctx.activeAccount,
      store: ctx.store,
      engine: ctx.engine,
      remote: ctx.remote,
    });
    this.configured = lease.store.settings.mcpServers;
    const capture = (this.capture = new McpStdioCapture({
      owner: () => {
        try {
          this.current(lease);
          return {
            root: lease.store.root,
            accountScope: lease.account.id,
            scope: lease.scope,
          };
        } catch {
          return undefined;
        }
      },
      currentConfiguration: (name) =>
        this.current(lease).store.settings.mcpServers[name],
      helperPath: this.options.helperPath,
      node: this.options.node,
      secrets: (name) => this.lifecycle.redactionSecrets(name),
    }));
    const engine = lease.engine;
    engine.mcpNodeExecutable = this.options.node.executable;
    engine.mcpMaintenance = () =>
      Boolean(this.maintenance) || this.lease !== lease;
    engine.mcpRuntimeSecrets = () => {
      this.current(lease);
      return this.lifecycle.redactionSecrets();
    };
    engine.mcpRuntimeConfig = (name, entry) => {
      this.current(lease);
      try {
        return this.lifecycle.runtimeConfig(name, entry);
      } catch {
        const error = "MCP server startup failed.";
        engine.mcpStartup.set(name, { status: "failed", error });
        engine.mcpLogs.record(name, "failed", error);
        return undefined;
      }
    };
    engine.mcpLaunchConfig = (name, entry) => {
      this.current(lease);
      const env = entry.env as Record<string, unknown> | undefined;
      const proof =
        typeof env?.ELECTRON_RUN_AS_NODE === "string"
          ? { value: env.ELECTRON_RUN_AS_NODE }
          : undefined;
      const wrapped = capture.launchWrapper(name, entry, proof);
      const raw = lease.store.settings.mcpServers[name] as
        Record<string, unknown> | undefined;
      if (raw?.claudex_extension_settings !== undefined && !wrapped.supported)
        return undefined;
      return wrapped.supported ? wrapped.entry : entry;
    };
    await capture.start();
    if (this.lease !== lease) capture.retire();
  }
  read(name: string) {
    this.current();
    if (!this.capture) throw Error("This extension is unavailable.");
    return this.capture.read(name);
  }
  register(handle: IpcHandle) {
    registerDesktopExtensionHandlers(handle, this.lifecycle);
  }
  retire() {
    this.lease = undefined;
    this.maintenance = undefined;
    this.capture?.retire();
    this.capture = undefined;
  }
}
