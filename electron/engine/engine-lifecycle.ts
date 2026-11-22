import { ConnectorClients } from "../connectors/connector-clients";
import { mcpSecrets, redactMcpText } from "../connectors/mcp-connection-logs";
import { StepClock } from "../app/start-timing";
import { codexModelCatalog, codexCatalogEfforts } from "./codex-model-catalog";
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
import { codeInterruptInFlight } from "./code-send-start";
import { spaceSkillPaths } from "../skills/space-skills";
import { assertSkillsFolderPrivate } from "../skills/skill-private";
import { recordCodeLimitRefusal } from "./engine-status";

/** A host retirement is distinct from an upstream startup failure. */
class RetiredEngineStartup extends Error {
  constructor() { super("The account or engine startup changed. Check the session before retrying."); }
}
const startupOwners = new WeakMap<object, object>();

function settleWorkflowThreads(engine: Engine, status: "failed" | "interrupted", error?: string) {
  for (const threadId of engine.workflowThreads.keys())
    engine.notification({
      method: "turn/completed",
      params: { threadId, turn: { status, ...(error ? { error: { message: error } } : {}) } },
    });
  engine.workflowThreads.clear();
}

function readRetainedCodexConfig(file: string) {
  try {
    const { plugins, marketplaces, windows } = TOML.parse(fs.readFileSync(file, "utf8"));
    const table = (value: unknown) =>
      !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
    return {
      ...(table(plugins) ? { plugins } : {}),
      ...(table(marketplaces) ? { marketplaces } : {}),
      ...(process.platform === "win32" && table(windows) &&
        (windows as Record<string, unknown>).sandbox === "elevated"
        ? { windows: { sandbox: "elevated" as const } }
        : {}),
    };
  } catch {}
  return {};
}

export async function ensure(
  this: Engine,
  provider: Provider,
  options: { interactive?: boolean; current?: () => boolean } = {},
) {
  const store = this.store;
  const check = () => {
    if (!options.current) return;
    let current = false;
    try { current = options.current() === true && this.store === store; } catch {}
    if (!current) throw new RetiredEngineStartup();
  };
  check();
  this.assertMcpAvailable();
  const waiting = this.starting;
  if (waiting) {
    try { await waiting; }
    catch (error) { check(); if (!options.current || !(error instanceof RetiredEngineStartup)) throw error; }
    check();
  }
  this.assertMcpAvailable();
  const modelEfforts = this.launcher ? [] : codexCatalogEfforts([provider.model, ...provider.models], this.requestOptions(provider).modelEfforts);
  const catalogCurrent = modelEfforts.length === this.startedModelEfforts.length && modelEfforts.every(({ model, efforts }) => {
    const started = this.startedModelEfforts.find((entry) => entry.model === model)?.efforts;
    return started?.length === efforts.length && efforts.every((effort, index) => effort === started[index]);
  });
  const mcpServers = this.mcpConfig();
  if (this.rpc && this.state.state === "ready" && this.providerId === provider.id &&
      catalogCurrent && (this.startedMcp === this.runtimeKey(mcpServers) ||
        (this.startedMcpServers === mcpServers && this.ownBusy()))) return;
  if (this.rpc && this.ownBusy())
    throw new Error("Wait for the current task to finish before switching connections.");
  check();
  this.interactiveStart = options.interactive ?? true;
  const starting = this.start(provider, options.current);
  this.starting = starting;
  try {
    await starting;
    check();
    this.assertMcpAvailable();
  } finally {
    if (this.starting === starting) this.starting = undefined;
  }
}

export function rememberMcpSecrets(this: Engine) {
  for (const name of Object.keys(this.store.settings.mcpServers))
    for (const value of Object.values(this.connectorHeaders?.(name) ?? {}))
      if (value) this.retainedMcpSecrets.add(value);
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
  const credentials = new ConnectorClients(this.store.root);
  const servers = Object.fromEntries(Object.entries(this.store.settings.mcpServers).filter(([name, config]) => {
    const url = (config as { url?: string } | undefined)?.url;
    if (!url) return true;
    if (this.connectorAuthStatus?.(name, url) === "disconnected") return false;
    return credentials.get(name, url)?.oauth?.posture !== "auth_required" ||
      Boolean(this.connectorHeaders?.(name)?.Authorization);
  }));
  return mcpServersConfig({
    servers,
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

export function runtimeKey(this: Engine, mcpServers = this.mcpConfig()) {
  const env = this.extensions.processEnv();
  const config = this.extensions.appServerConfig(!this.launcher);
  const own = this.store.settings.localEnvironmentVariables?.trim() ?? "";
  const spaceSkillPreferences =
    this.environment.kind === "space"
      ? this.store.settings.disabledSkills ?? []
      : [];
  // The egress profile lives in config.toml: a new list restarts the agent.
  const egress = this.egress();
  return Object.keys(env).length ||
    Object.keys(config).length ||
    own ||
    spaceSkillPreferences.length ||
    egress.kind === "profile"
    ? JSON.stringify([
        mcpServers,
        env,
        config,
        own,
        spaceSkillPreferences,
        ...(egress.kind === "profile" ? [egress] : []),
      ])
    : mcpServers;
}

export async function start(this: Engine, provider: Provider, hostCurrent?: () => boolean) {
  const store = this.store, owner = {};
  startupOwners.set(this, owner);
  let published = false;
  const current = () => {
    if (!hostCurrent) return true;
    try { return hostCurrent() === true && this.store === store && startupOwners.get(this) === owner; }
    catch { return false; }
  };
  const check = () => { if (!current()) throw new RetiredEngineStartup(); };
  const runtimeCurrent = () => this.store === store && startupOwners.get(this) === owner &&
    (published || current());
  check();
  let createdGateway: ProviderServiceClient | undefined;
  let createdRpc: CodexRPC | undefined;
  let capturedLauncher = this.launcher;
  const acceptsGateway = () => runtimeCurrent() && !!createdGateway && this.gateway === createdGateway;

  const clock = new StepClock();
  this.startSteps = undefined;
  try { await this.stop(hostCurrent ? current : undefined); }
  catch (error) { check(); throw error; }
  check();
  this.mcpStartup.clear();
  this.intentionalStop = false;
  this.providerId = provider.id;
  this.status({ state: "starting" });
  try {
    const launcher = capturedLauncher = this.launcher;
    if (!launcher) {
      await this.extensions.prepareAppServer();
      check();
    }
    const home = path.join(this.spaceRoot, "codex-home");
    const configFile = path.join(home, "config.toml");
    const retainedConfig = launcher ? {} : readRetainedCodexConfig(configFile);
    const windowsMode = retainedConfig.windows?.sandbox ?? "unelevated";
    if (!launcher) prepareCodexCache(store.root, this.spaceRoot);
    if (this.environment.kind === "space")
      assertSkillsFolderPrivate({ store, window: undefined });
    check();
    const requestOptions = this.requestOptions(provider);
    const gateway = createdGateway = new ProviderServiceClient(
      this.serviceScript,
      store.root,
      store.settings.providers.find((p) => p.id === this.providerId) ??
        provider,
      this.secret(this.providerId),
      this.vaultKey,
      this.vaultRoot,
      this.limits,
      (event) => { if (acceptsGateway()) this.captureAgentPrompt(event); },
      (refusal) => {
        if (!acceptsGateway()) return;
        this.lastRefusal = { ...refusal, at: Date.now() };
        recordCodeLimitRefusal.call(this, refusal);
        this.onRefusal?.(refusal);
      },
      {
        onToolDescription: (event) => { if (acceptsGateway()) this.signals.toolDescription(event); },
        onWebSources: (event) => { if (acceptsGateway()) this.signals.webSources(event); },
        onGeneratedImage: (event) => { if (acceptsGateway()) this.signals.generatedImage(event); },
        onImageRequest: (event) => { if (acceptsGateway()) this.signals.imageRequest(event); },
        onToolStart: (event) => { if (acceptsGateway()) this.signals.toolStart(event); },
      },
      requestOptions,
    );
    check();
    this.gateway = gateway;
    gateway.sessionGroupKeys = this.groupKeys(this.providerId);
    check();
    await gateway.start();
    check();
    clock.mark("gateway");
    this.sentRequestOptions = JSON.stringify(requestOptions);
    this.startedModelEfforts = launcher ? [] : codexCatalogEfforts([provider.model, ...provider.models], requestOptions.modelEfforts);
    this.startedMcpServers = this.mcpConfig();
    this.startedMcp = this.runtimeKey(this.startedMcpServers);
    const mcpServers = JSON.parse(this.startedMcpServers);
    this.startedEgressProfile = !launcher && this.egress().kind === "profile";
    // An SSH host's trusted projects come from this computer at every
    // start, as the launcher replaces the host's config.toml.
    const remoteProjects = this.sshTrust?.projects(this.remoteTrustId!) ?? {};
    const configToml = TOML.stringify({
      mcp_oauth_credentials_store: "file",
      mcp_servers: mcpServers,
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
        gateway.url,
        gateway.token,
      );
      // Trusted projects (workspace trust) live in this file only:
      // Codex ignores them as `-c` overrides, so they are kept.
      const projects = readCodexProjects(configFile);
      fs.writeFileSync(
        configFile,
        TOML.stringify({
          ...imageProvider,
          // The egress permission profile, while Chat's code uses one.
          ...egressProfileConfig(this.egress()),
          mcp_oauth_credentials_store: "file",
          mcp_servers: mcpServers,
          ...(Object.keys(projects).length ? { projects } : {}),
          ...retainedConfig,
        } as any),
        { mode: 0o600 },
      );
    }
    const config: Record<string, unknown> = {
      model_provider: "claudex",
      "model_providers.claudex": {
        name: "Claudex gateway",
        // On an SSH host the launcher adds the forwarded address.
        ...(launcher ? {} : { base_url: gateway.url }),
        env_key: "CLAUDEX_GATEWAY_TOKEN",
        wire_api: "responses",
        requires_openai_auth: false,
        request_max_retries: 0,
        // The gateway can switch upstreams only before it emits output. Once
        // a stream starts, let Codex recover its current sampling request with
        // the existing tool history; never resend the whole user turn here.
        stream_max_retries: 5,
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
          codexModelCatalog({ modelEfforts: this.startedModelEfforts, reviewModels: [provider.model, ...provider.models] }),
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
      config["windows.sandbox"] = windowsMode;
    // Extensions add config of their own (S1); they cannot replace the
    // gateway, sandbox or secret-filtering settings above.
    for (const [key, value] of Object.entries(
      this.extensions.appServerConfig(!launcher),
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
    check();
    const rpc = createdRpc = new CodexRPC();
    check();
    this.rpc = rpc;
    // A failure while handling one notification must not stop the process.
    rpc.on("notification", (msg) => {
      if (!runtimeCurrent() || this.rpc !== rpc) return;
      try {
        this.notification(msg);
      } catch (error) {
        console.error("claudex: a notification could not be handled", error);
      }
    });
    rpc.on("request", (msg) => { if (runtimeCurrent() && this.rpc === rpc) this.request(msg); });
    rpc.on("failure", (error: Error) => {
      if (!runtimeCurrent() || this.intentionalStop || this.rpc !== rpc) return;
      const message = launcher
        ? `Lost the connection to ${launcher.label || "the SSH host"}.`
        : error.message;
      this.status({ state: "error", error: message });
      const executionId = launcher?.remoteExecutionId;
      let cutRecorded = false;
      for (const c of store.conversations) {
        if (!this.owns(c)) continue;
        let changed = false;
        for (const t of c.turns)
          if (t.status === "inProgress" && !isOutboxTurn(t)) {
            const cut = executionId && c.mode === "code" && c.threadId &&
              !t.id.startsWith("pending-") && !t.compaction &&
              !t.userStopped && !codeInterruptInFlight(t);
            finishTurn(t, cut ? "interrupted" : "failed");
            if (cut) {
              t.sshCut = { executionId, at: Date.now() };
              cutRecorded = true;
            }
            t.error = message;
            this.extensions.turnCompleted(c, t, () => this.changed(c, true));
            changed = true;
          }
        if (changed) this.changed(c, true);
      }
      if (cutRecorded) store.flush();
      this.clearApprovals();
      settleWorkflowThreads(this, "failed", message);
      launcher?.exited();
    });
    // The provider service owns the upstream key. Codex receives only a loopback capability token.
    // Extension variables (MCP tokens) are named *TOKEN* or *SECRET*, so
    // the shell environment policy above keeps them from commands.
    let info: any;
    if (launcher) {
      // R9: Codex on an SSH host, its stdio through ssh. The token goes
      // through stdin; this computer's environment stays here.
      check();
      const launch = await launcher.launch({
        args: args.slice(3),
        configToml,
        gatewayUrl: gateway.url,
        gatewayToken: gateway.token,
        interactive: this.interactiveStart,
      });
      check();
      info = await rpc.startWith(launch.spawn, launch.preamble);
      check();
      const cutExecutions = store.conversations.flatMap((conversation) => {
        if (!this.owns(conversation) || conversation.archived) return [];
        const cut = conversation.turns.at(-1)?.sshCut;
        return cut && !cut.executionEnded && !cut.continuationId &&
          Date.now() - cut.at <= 86_400_000 && /^e[0-9a-f]{16}$/.test(cut.executionId)
          ? [cut.executionId]
          : [];
      });
      launcher.started([...new Set(cutExecutions)]);
    } else {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Code home → Local ▾ → Edit local environment (R-0386).
        ...parseEnvFile(store.settings.localEnvironmentVariables ?? ""),
        ...this.options.environmentVariables,
        ...this.extensions.processEnv(),
        CODEX_HOME: home,
        CLAUDEX_GATEWAY_TOKEN: gateway.token,
      };
      delete env.OPENAI_API_KEY;
      if (process.platform === "win32") {
        // Codex clones plugin marketplaces into a staging directory under CODEX_HOME.
        const gitConfigCount = Number(env.GIT_CONFIG_COUNT ?? 0);
        if (
          Number.isSafeInteger(gitConfigCount) &&
          gitConfigCount >= 0 &&
          gitConfigCount < 2_147_483_647
        ) {
          env["GIT_CONFIG_KEY_" + gitConfigCount] = "core.longpaths";
          env["GIT_CONFIG_VALUE_" + gitConfigCount] = "true";
          env.GIT_CONFIG_COUNT = String(gitConfigCount + 1);
        }
      }
      withLoopbackBypass(env);
      check();
      info = await rpc.start(this.options.binary ?? this.binary, args, env);
      check();
      clock.mark("app-server");
      // The restricted-token sandbox sets itself up on first use. Turns wait
      // for its setup if it is still running.
      const sandboxReady = await this.windowsSandbox.check(rpc, windowsMode);
      check();
      if (!sandboxReady && windowsMode === "unelevated")
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
      check();
      await rpc
        .call("skills/config/write", {
          path: imagegen ?? builtinImagegenSkill(home),
          enabled: false,
        })
        .catch(() => {});
      check();
      // config.toml is rewritten at every start; switched-off skills are applied again.
      const spaceSkills =
        this.environment.kind === "space"
          ? spaceSkillPaths(store.root, home)
          : undefined;
      for (const skill of store.settings.disabledSkills ?? []) {
        check();
        const skillPath = spaceSkills?.runtimePath(skill) ?? skill;
        await rpc
          .call("skills/config/write", { path: skillPath, enabled: false })
          .catch(() => {});
        check();
      }
      clock.mark("skills");
    }
    check();
    this.startSteps = clock.steps;
    this.status({
      state: "ready",
      version: info.userAgent ?? "Codex 0.144.1",
    });
    check();
    published = true;
  } catch (error) {
    const failure = current() ? error : new RetiredEngineStartup();
    if (current()) { this.status({ state: "error", error: (error as Error).message }); this.intentionalStop = true; }
    // Only these newly created resources belong to this attempt. A shared
    // launcher cannot be disposed after another startup has taken ownership.
    const cleanup = [
      async () => { await createdGateway?.close(); if (this.gateway === createdGateway) this.gateway = undefined; },
      async () => { await createdRpc?.stop(); if (this.rpc === createdRpc) this.rpc = undefined; },
      async () => {
        if (startupOwners.get(this) !== owner || this.launcher !== capturedLauncher) return;
        if (current()) capturedLauncher?.failed(error as Error);
        await capturedLauncher?.dispose();
      },
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      Promise.allSettled(cleanup.map(fn => Promise.resolve().then(fn))),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000); }),
    ]);
    clearTimeout(timer);
    if (!results || results.some(result => result.status === "rejected"))
      console.error("Retired engine startup cleanup was not confirmed.");
    throw failure;
  }
}

export async function stop(this: Engine, hostCurrent?: () => boolean) {
  const store = this.store, rpc = this.rpc, gateway = this.gateway, launcher = this.launcher;
  const owner = startupOwners.get(this);
  let expectedRpc = rpc, expectedGateway = gateway;
  const check = () => {
    let permitted = true;
    try { if (hostCurrent) permitted = hostCurrent() === true; } catch { permitted = false; }
    if (!permitted || this.store !== store || startupOwners.get(this) !== owner ||
        this.rpc !== expectedRpc || this.gateway !== expectedGateway || this.launcher !== launcher)
      throw new RetiredEngineStartup();
  };
  check();
  this.capabilityTips.stop();
  this.titleOffers.stop();
  this.sessionAssistance.stop();
  this.safeguardModels.clear();
  this.intentionalStop = true;
  this.windowsSandbox.reset();
  check();
  await rpc?.stop();
  check();
  this.rpc = expectedRpc = undefined;
  await gateway?.close();
  check();
  this.gateway = expectedGateway = undefined;
  await launcher?.dispose();
  check();
  this.loaded.clear();
  this.threadLimits.clear();
  this.threadOrganizationPlugins.clear();
  this.steers.clear();
  this.routes.clear();
  this.signals.clearImageRequests();
  this.sides.dropAll(new Error("The side chat ended when the agent stopped."));
  check();
  this.agentRoutes.clear();
  this.pendingAgentPrompts.clear();
  this.pendingPatches.clear();
  this.sentRequestOptions = "";
  this.clearApprovals();
  check();
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
        this.extensions.turnCompleted(c, t, () => this.changed(c, true));
        changed = true;
      }
    if (changed) { this.changed(c, true); check(); }
  }
  settleWorkflowThreads(this, "interrupted");
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
