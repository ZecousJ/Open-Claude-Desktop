import { mcpSecrets, redactMcpText } from "../connectors/mcp-connection-logs";
import { StepClock } from "../app/start-timing";
import { codexModelCatalog } from "./codex-model-catalog";
import {
  builtinImagegenSkill,
  installApiImageSkill,
  writeImageProviderFiles,
} from "../skills/api-image";
import fs from "node:fs";
import { prepareCodexCache, pruneCodexCache } from "./codex-cache";
import { allResponses } from "../../shared/provider-routes";
import { finishTurn } from "../../shared/activity";
import path from "node:path";
import TOML from "@iarna/toml";
import { ProviderServiceClient } from "./provider-service-client";
import { CodexRPC } from "./rpc";
import { mcpServersConfig } from "./mcp-config";
import { readCodexProjects } from "../workspace/workspace-trust";
import { preference } from "../../shared/settings-extras";
import type { Provider } from "../../shared/types";
import { configKeysOverlap } from "./engine-extensions";
import { parseEnvFile } from "../../shared/env-file";
import { isOutboxTurn } from "../ssh/outbox";
import { egressProfileConfig } from "../../shared/local-egress";
import { withLoopbackBypass } from "./engine-support";
import type { Engine } from "./engine";

export async function ensure(
  this: Engine,
  provider: Provider,
  options: { interactive?: boolean } = {},
) {
  this.assertMcpAvailable();
  if (this.starting) await this.starting;
  this.assertMcpAvailable();
  if (
    this.rpc &&
    this.state.state === "ready" &&
    this.providerId === provider.id &&
    // A changed connector allowlist applies at the next idle send.
    (this.startedMcp === this.runtimeKey() || this.ownBusy())
  )
    return;
  if (this.rpc && this.ownBusy())
    throw new Error(
      "Wait for the current task to finish before switching connections.",
    );
  this.interactiveStart = options.interactive ?? true;
  this.starting = this.start(provider);
  try {
    await this.starting;
    this.assertMcpAvailable();
  } finally {
    this.starting = undefined;
  }
}

export function rememberMcpSecrets(this: Engine) {
  for (const value of [
    ...mcpSecrets(this.store.settings.mcpServers),
    ...(this.mcpRuntimeSecrets?.() ?? []),
  ])
    if (value) this.retainedMcpSecrets.add(value);
}

export function safeMcpError(this: Engine, raw: unknown): string | undefined {
  if (raw == null) return;
  try {
    this.rememberMcpSecrets();
    return typeof raw === "string"
      ? redactMcpText(raw, [...this.retainedMcpSecrets])
      : "MCP server startup failed.";
  } catch {
    return "MCP server startup failed.";
  }
}

/** The MCP servers Codex is started with (mcp-config.ts). */
export function mcpConfig(this: Engine) {
  try {
    this.rememberMcpSecrets();
  } catch {
    /* Notifications fail closed if native secrets cannot be read. */
  }
  return mcpServersConfig({
    servers: this.store.settings.mcpServers,
    policy: this.policy(),
    reserved: this.extensions.reservedMcpServerNames(),
    environmentKind: this.environment.kind,
    remote: Boolean(this.launcher),
    runtimeConfig: this.mcpRuntimeConfig,
    launchConfig: this.mcpLaunchConfig,
    headers: this.connectorHeaders,
    serviceScript: this.serviceScript,
    nodeExecutable: this.mcpNodeExecutable,
    builtInNode: preference(this.store.settings, "extensionBuiltInNode"),
  });
}

/**
 * What the running agent was started with and a change of which restarts
 * it at the next idle send: connectors, and the environment and config
 * extensions add (kept in memory only).
 */
export function runtimeKey(this: Engine) {
  const env = this.extensions.processEnv();
  const config = this.extensions.appServerConfig();
  const own = this.store.settings.localEnvironmentVariables?.trim() ?? "";
  // The egress profile lives in config.toml: a new list restarts the agent.
  const egress = this.egress();
  return Object.keys(env).length ||
    Object.keys(config).length ||
    own ||
    egress.kind === "profile"
    ? JSON.stringify([
        this.mcpConfig(),
        env,
        config,
        own,
        ...(egress.kind === "profile" ? [egress] : []),
      ])
    : this.mcpConfig();
}

export async function start(this: Engine, provider: Provider) {
  const clock = new StepClock();
  this.startSteps = undefined;
  await this.stop();
  this.mcpStartup.clear();
  this.intentionalStop = false;
  this.providerId = provider.id;
  this.status({ state: "starting" });
  try {
    const launcher = this.launcher;
    const home = path.join(this.spaceRoot, "codex-home");
    if (!launcher) prepareCodexCache(this.store.root, this.spaceRoot);
    this.gateway = new ProviderServiceClient(
      this.serviceScript,
      this.store.root,
      this.store.settings.providers.find((p) => p.id === this.providerId) ??
        provider,
      this.secret(this.providerId),
      this.vaultKey,
      this.vaultRoot,
      this.limits,
      (event) => this.captureAgentPrompt(event),
      (refusal) => {
        this.lastRefusal = { ...refusal, at: Date.now() };
        this.onRefusal?.(refusal);
      },
      {
        onToolDescription: (event) => this.signals.toolDescription(event),
        onWebSources: (event) => this.signals.webSources(event),
        onGeneratedImage: (event) => this.signals.generatedImage(event),
        onToolStart: (event) => this.signals.toolStart(event),
      },
      this.requestOptions(provider),
    );
    this.gateway.sessionGroupKeys = this.groupKeys(this.providerId);
    await this.gateway.start();
    clock.mark("gateway");
    this.sentRequestOptions = JSON.stringify(this.requestOptions(provider));
    this.startedMcp = this.runtimeKey();
    this.startedEgressProfile = !launcher && this.egress().kind === "profile";
    // An SSH host's trusted projects come from this computer at every
    // start, as the launcher replaces the host's config.toml.
    const remoteProjects = this.sshTrust?.projects(this.sshHostId!) ?? {};
    const configToml = TOML.stringify({
      mcp_servers: JSON.parse(this.mcpConfig()),
      ...(Object.keys(remoteProjects).length
        ? { projects: remoteProjects }
        : {}),
    } as any);
    // An SSH engine's config.toml goes to the host with its start (R9).
    if (!launcher) {
      // Pictures go through the api-image skill and this gateway, whatever
      // the model (electron/skills/api-image.ts).
      installApiImageSkill(home);
      const imageProvider = writeImageProviderFiles(
        home,
        this.gateway.url,
        this.gateway.token,
      );
      // Trusted projects (workspace trust) live in this file only:
      // Codex ignores them as `-c` overrides, so they are kept.
      const projects = readCodexProjects(path.join(home, "config.toml"));
      fs.writeFileSync(
        path.join(home, "config.toml"),
        TOML.stringify({
          ...imageProvider,
          // The egress permission profile, while Chat's code uses one.
          ...egressProfileConfig(this.egress()),
          mcp_servers: JSON.parse(this.mcpConfig()),
          ...(Object.keys(projects).length ? { projects } : {}),
        } as any),
        { mode: 0o600 },
      );
    }
    const config: Record<string, unknown> = {
      model_provider: "claudex",
      "model_providers.claudex": {
        name: "Claudex gateway",
        // On an SSH host the launcher adds the forwarded address.
        ...(launcher ? {} : { base_url: this.gateway.url }),
        env_key: "CLAUDEX_GATEWAY_TOKEN",
        wire_api: "responses",
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
        supports_websockets: false,
      },
      web_search: "disabled",
      "features.enable_request_compression": false,
      "features.responses_websockets_v2": false,
      "analytics.enabled": false,
      check_for_update_on_startup: false,
      // Codex caps this at 90% of the model's window; a thread's own limit
      // from the model catalog replaces it (contextConfig).
      model_auto_compact_token_limit: 1000000,
      "shell_environment_policy.exclude": [
        "CLAUDEX_GATEWAY_TOKEN",
        "OPENAI_API_KEY",
        "*TOKEN*",
        "*SECRET*",
        "*PASSWORD*",
      ],
    };
    // Files show as the model writes them (codex-model-catalog.ts). The
    // catalog is a file in CODEX_HOME, which an SSH host does not share.
    if (!launcher) {
      const catalog = path.join(home, "claudex-models.json");
      fs.writeFileSync(
        catalog,
        JSON.stringify(
          // Each model and its twin with the tools preloaded: Tool access
          // is chosen per conversation (shared/tool-search-mode.ts).
          codexModelCatalog(),
        ),
      );
      config.model_catalog_json = catalog;
      config["features.apply_patch_streaming_events"] = true;
      config.suppress_unstable_features_warning = true;
    }
    // Child agents require the Responses tool protocol; Chat Completions cannot represent its deferred tool search.
    // With several service groups every one of them must speak Responses (MG).
    config["features.multi_agent"] = allResponses(provider);
    if (allResponses(provider)) {
      config["features.multi_agent_v2"] = true;
    }
    if (!launcher && process.platform === "win32")
      config["windows.sandbox"] = "unelevated";
    // Extensions add config of their own (S1); they cannot replace the
    // gateway, sandbox or secret-filtering settings above.
    for (const [key, value] of Object.entries(
      this.extensions.appServerConfig(),
    ))
      if (!Object.keys(config).some((own) => configKeysOverlap(own, key)))
        config[key] = value;
    const args = ["app-server", "--listen", "stdio://"];
    for (const [key, value] of Object.entries(config))
      args.push(
        "-c",
        `${key}=${
          typeof value === "object" && !Array.isArray(value)
            ? "{ " +
              Object.entries(value as any)
                .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
                .join(", ") +
              " }"
            : JSON.stringify(value)
        }`,
      );
    const rpc = (this.rpc = new CodexRPC());
    // A failure while handling one notification must not stop the process.
    rpc.on("notification", (msg) => {
      try {
        this.notification(msg);
      } catch (error) {
        console.error("claudex: a notification could not be handled", error);
      }
    });
    rpc.on("request", (msg) => this.request(msg));
    rpc.on("failure", (error: Error) => {
      if (this.intentionalStop || this.rpc !== rpc) return;
      const message = launcher
        ? `Lost the connection to ${launcher.label || "the SSH host"}.`
        : error.message;
      this.status({ state: "error", error: message });
      for (const c of this.store.conversations) {
        if (!this.owns(c)) continue;
        let changed = false;
        for (const t of c.turns)
          if (t.status === "inProgress" && !isOutboxTurn(t)) {
            finishTurn(t, "failed");
            t.error = message;
            changed = true;
          }
        if (changed) this.changed(c, true);
      }
      this.clearApprovals();
      launcher?.exited();
    });
    // The provider service owns the upstream key. Codex receives only a loopback capability token.
    // Extension variables (MCP tokens) are named *TOKEN* or *SECRET*, so
    // the shell environment policy above keeps them from commands.
    let info: any;
    if (launcher) {
      // R9: Codex on an SSH host, its stdio through ssh. The token goes
      // through stdin; this computer's environment stays here.
      const launch = await launcher.launch({
        args: args.slice(3),
        configToml,
        gatewayUrl: this.gateway.url,
        gatewayToken: this.gateway.token,
        interactive: this.interactiveStart,
      });
      info = await rpc.startWith(launch.spawn, launch.preamble);
      launcher.started();
    } else {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Code home → Local ▾ → Edit local environment.
        ...parseEnvFile(this.store.settings.localEnvironmentVariables ?? ""),
        ...this.options.environmentVariables,
        ...this.extensions.processEnv(),
        CODEX_HOME: home,
        CLAUDEX_GATEWAY_TOKEN: this.gateway.token,
      };
      delete env.OPENAI_API_KEY;
      withLoopbackBypass(env);
      info = await rpc.start(this.options.binary ?? this.binary, args, env);
      clock.mark("app-server");
      // On Windows the sandbox sets itself up the first time: no step in
      // Settings. Turns wait for it (ensureReady) if it is still running.
      if (!(await this.windowsSandbox.check(rpc)))
        void this.windowsSandbox
          .setup(rpc, this.sandboxSetupFolder())
          .catch(() => {});
      // Codex's own image skill gives way to api-image. Its path is the
      // one Codex lists: in a runner space's sandbox its home is
      // /codex-home, not this computer's folder.
      const imagegen = await rpc
        .call("skills/list", { forceReload: true })
        .then(
          (listed: { data?: { skills?: { path?: string }[] }[] }) =>
            (listed.data ?? [])
              .flatMap((group) => group.skills ?? [])
              .map((skill) => skill.path)
              .find(
                (file): file is string =>
                  typeof file === "string" &&
                  /[\\/]\.system[\\/]imagegen[\\/]SKILL\.md$/.test(file),
              ),
          () => undefined,
        );
      await rpc
        .call("skills/config/write", {
          path: imagegen ?? builtinImagegenSkill(home),
          enabled: false,
        })
        .catch(() => {});
      // config.toml is rewritten at every start; switched-off skills are applied again.
      for (const skill of this.store.settings.disabledSkills ?? [])
        await rpc
          .call("skills/config/write", { path: skill, enabled: false })
          .catch(() => {});
      clock.mark("skills");
    }
    this.startSteps = clock.steps;
    this.status({
      state: "ready",
      version: info.userAgent ?? "Codex 0.144.1",
    });
  } catch (error) {
    this.status({ state: "error", error: (error as Error).message });
    this.intentionalStop = true;
    await this.gateway?.close();
    this.gateway = undefined;
    await this.rpc?.stop();
    this.rpc = undefined;
    this.launcher?.failed(error as Error);
    await this.launcher?.dispose();
    throw error;
  }
}

export async function stop(this: Engine) {
  this.capabilityTips.stop();
  this.titleOffers.stop();
  this.sessionAssistance.stop();
  this.safeguardModels.clear();
  this.intentionalStop = true;
  this.windowsSandbox.reset();
  await this.rpc?.stop();
  this.rpc = undefined;
  await this.gateway?.close();
  this.gateway = undefined;
  await this.launcher?.dispose();
  this.loaded.clear();
  this.threadLimits.clear();
  this.steers.clear();
  this.routes.clear();
  this.sides.dropAll(new Error("The side chat ended when the agent stopped."));
  this.agentRoutes.clear();
  this.pendingAgentPrompts.clear();
  this.pendingPatches.clear();
  this.sentRequestOptions = "";
  this.clearApprovals();
  for (const c of this.store.conversations) {
    // Another engine's turns, and messages waiting for an SSH host, stay.
    if (!this.owns(c)) continue;
    let changed = false;
    for (const t of c.turns)
      if (
        t.status === "inProgress" &&
        !isOutboxTurn(t) &&
        t !== this.earlyTurn
      ) {
        finishTurn(t, "interrupted");
        changed = true;
      }
    if (changed) this.changed(c, true);
  }
  for (const timer of this.notificationTimer.values()) clearTimeout(timer);
  this.notificationTimer.clear();
  this.state = { state: "stopped" };
  if (!this.launcher && this.environment.kind === "space")
    pruneCodexCache(this.store.root, this.spaceRoot);
}

export async function setupWindowsSandbox(
  this: Engine,
): Promise<{ ready: boolean; message: string }> {
  if (process.platform !== "win32")
    return {
      ready: true,
      message: "This platform doesn't need the Windows sandbox.",
    };
  if (this.ownBusy())
    throw new Error(
      "Wait for the current task to finish before setting up the Windows sandbox.",
    );
  const provider = this.store.settings.providers.find(
    (p) => p.id === this.store.settings.activeProviderId,
  );
  if (!provider) throw new Error("Add a model connection first.");
  await this.ensure(provider);
  return this.windowsSandbox.setup(this.rpc!, this.sandboxSetupFolder());
}

/** The folder the Windows sandbox setup runs in (Claudex's own workspace). */
export function sandboxSetupFolder(this: Engine) {
  const cwd = path.join(this.store.root, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}
