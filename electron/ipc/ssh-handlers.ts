import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { SshToolGrantStore } from "../ssh/tool-grants";
import type { SshStatus } from "../../shared/ssh-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { testSshHost } from "../ssh/connection";
import { errorMessage } from "../ssh/connection-support";
import { checkHostFields, checkHostId, MAX_HOSTS } from "../ssh/host-store";
import { checkSshPassword } from "../ssh/password-store";
import { forgetHostKey } from "../ssh/known-hosts";
import {
  checkRemotePath,
  folderCheckScript,
  listDirectoryScript,
  parseDirectoryListing,
  parseFolderCheck,
} from "../ssh/remote-scripts";
import { configHostSuggestions } from "../ssh/ssh-config";
import {
  checkCustomSsh,
  readSshVersion,
  supportedSshVersion,
} from "../ssh/ssh-binary";
import { sshPolicyError } from "../ssh/policy";
import { checkHostPath, connectionRunner, RemoteUnavailableError, RemoteWorkspace, remoteWorkspace } from "../ssh/remote-workspace";
import { sshSlashCommands } from "../ssh/slash-commands";
import { applySshSettingsPolicy, readSshSettings, type ResolvedSshSettings } from "../ssh/settings";
import { contextSources } from "../workspace/workspace-fs";
import {
  SshWorkspaceTrustStore,
  sshWorkspaceTrustFile,
} from "../workspace/workspace-trust";
import { MAX_REMOTE_FOLDERS, SshService } from "./ssh";
import type { SshServiceOptions } from "./ssh";
import { codeStartProvider } from "./code-model-preferences";

/** A connected host's connection, or an error the window can show. */
function readyConnection(service: SshService, hostId: string) {
  const connection = service.existing(checkHostId(hostId));
  const host = service.hosts.get(hostId);
  if (!host) throw new Error("That SSH connection no longer exists.");
  if (!connection?.live())
    throw new Error(`Connect to ${host.label} first.`);
  return connection;
}

export function registerSshHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  options: SshServiceOptions = {},
) {
  let service: SshService | undefined;
  const ssh = () => {
    if (!service) {
      service = new SshService(ctx, options);
      ctx.services.ssh = service;
    }
    return service;
  };
  ctx.onAccountActivated(() => void ssh());
  ctx.onAccountDeactivating(async () => {
    const current = service;
    service = undefined;
    if (ctx.services.ssh === current) ctx.services.ssh = undefined;
    await current?.dispose();
  });
  const allowedOrThrow = () => {
    if (!ssh().allowed()) throw new Error(errorMessage("policy-disabled", ""));
  };
  handle("officialSshTarget", (raw: unknown) => {
    allowedOrThrow();
    const target = z.object({
      kind: z.literal("ssh").optional(),
      id: z.string().optional(),
      sshHost: z.string().min(1),
      sshPort: z.number().int().optional(),
      sshIdentityFile: z.string().optional(),
    }).parse(raw);
    const hosts = ssh().hosts.list().filter((host) =>
      (target.id === undefined || host.id === target.id) &&
      host.destination === target.sshHost &&
      (host.port ?? 22) === (target.sshPort ?? 22) &&
      (host.identityFile ?? "") === (target.sshIdentityFile ?? ""));
    if (hosts.length !== 1) throw Error("Choose a saved SSH connection.");
    return { kind: "ssh" as const, hostId: hosts[0].id };
  });
  handle("officialSetSshConfigs", async (raw: unknown) => {
    allowedOrThrow();
    const svc = ssh();
    const root = ctx.store?.root;
    const activation = ctx.accountActivationIdentity;
    const current = () => service === svc && ctx.accountRetiring !== true &&
      ctx.store?.root === root && ctx.accountActivationIdentity === activation;
    const requested = z.array(z.object({
      id: z.string(),
      name: z.string().optional(),
      sshHost: z.string(),
      sshPort: z.number().optional(),
      sshIdentityFile: z.string().optional(),
      remoteCwd: z.string().optional(),
      source: z.literal("desktop").optional(),
    })).max(MAX_HOSTS).parse(raw);
    const before = new Map(svc.hosts.list().map((host) => [host.id, host]));
    const unchanged = () => {
      if (!current() || !isDeepStrictEqual(
        svc.hosts.list().map(({ lastUsedAt: _lastUsedAt, ...host }) => host),
        [...before.values()].map(({ lastUsedAt: _lastUsedAt, ...host }) => host),
      )) throw Error("The SSH connections changed. Refresh them before saving.");
    };
    const after = new Map(requested.map((entry) => {
      const id = checkHostId(entry.id);
      return [id, checkHostFields({
        ...before.get(id),
        label: entry.name,
        destination: entry.sshHost,
        port: entry.sshPort,
        identityFile: entry.sshIdentityFile,
        defaultFolder: entry.remoteCwd,
      })] as const;
    }));
    if (after.size !== requested.length) throw Error("Duplicate SSH connection.");
    const removed = [...before.keys()].filter((id) => !after.has(id));
    const changed = [...after].filter(([id, fields]) => {
      const prior = before.get(id);
      return !prior || !isDeepStrictEqual(checkHostFields(prior), fields);
    });
    if (removed.length + changed.length > 1)
      throw Error("The SSH connections changed. Refresh them before saving.");
    const id = removed[0];
    if (id) {
      await svc.disconnect(id);
      unchanged();
      svc.hosts.delete(id);
      svc.passwords.delete(id);
      ctx.remoteFolders.delete(id);
      if (root) new SshWorkspaceTrustStore(sshWorkspaceTrustFile(root)).forget(id);
    } else if (changed.length) {
      const [id, fields] = changed[0];
      const prior = before.get(id);
      if (!prior) svc.hosts.add({ ...fields, id });
      else {
        const endpointChanged = prior.destination !== fields.destination ||
          prior.port !== fields.port || prior.identityFile !== fields.identityFile;
        if (endpointChanged) await svc.disconnect(id);
        unchanged();
        svc.hosts.save({ ...fields, id });
      }
      svc.prefetch();
    }
  });

  const grants = () => new SshToolGrantStore(ctx.store!.root);
  handle("sshToolGrants", async () => grants().list());
  handle(
    "sshRemoveToolGrant",
    async (endpointKey: unknown, server: unknown, toolName: unknown) => {
      if (
        ![endpointKey, server, toolName].every(
          (value) => typeof value === "string" && value.length <= 1024,
        )
      )
        throw new Error("This request is no longer valid.");
      grants().remove(
        endpointKey as string,
        server as string,
        toolName as string,
      );
    },
  );
  handle("sshClearToolGrants", async () => grants().clear());

  handle("sshListHosts", async () => {
    const svc = ssh();
    const allowed = svc.allowed();
    const sshPath = svc.defaultSsh();
    const hosts = (allowed ? svc.hosts.list() : []).map((host) =>
      svc.passwords.has(host.id) ? { ...host, hasPassword: true } : host,
    );
    let suggestions: string[] = [];
    if (allowed && sshPath) {
      const saved = new Set(hosts.map((host) => host.destination));
      suggestions = configHostSuggestions().filter((name) => !saved.has(name));
    }
    const sshVersion = allowed ? await svc.sshVersion() : undefined;
    return {
      hosts,
      suggestions,
      sshAvailable: allowed && !!sshPath,
      ...(sshVersion ? { sshVersion } : {}),
    };
  });

  handle("sshSaveHost", async (input: unknown) => {
    allowedOrThrow();
    const svc = ssh();
    const fields = checkHostFields(input);
    if (fields.sshPath) checkCustomSsh(fields.sshPath);
    const id = (input as { id?: unknown }).id;
    const before =
      id === undefined ? undefined : svc.hosts.get(checkHostId(id));
    const raw = input as { password?: unknown; clearPassword?: unknown };
    const password =
      raw.password === undefined || raw.password === ""
        ? undefined
        : checkSshPassword(raw.password);
    const host = svc.hosts.save({
      ...fields,
      ...(id === undefined ? {} : { id: checkHostId(id) }),
    });
    // The runtime is fetched to this computer now, ready to send.
    svc.prefetch();
    // An empty password keeps the saved one; Remove clears it.
    if (password !== undefined) svc.passwords.set(host.id, password);
    else if (raw.clearPassword === true) svc.passwords.delete(host.id);
    // A change to how the host is reached takes effect on the next connect.
    if (
      before &&
      (
        [
          "destination",
          "port",
          "identityFile",
          "sshPath",
          "forwardAgent",
        ] as const
      ).some((key) => before[key] !== host[key])
    )
      await svc.disconnect(host.id);
    return svc.passwords.has(host.id) ? { ...host, hasPassword: true } : host;
  });

  handle("sshDeleteHost", async (id: unknown) => {
    const svc = ssh();
    const hostId = checkHostId(id);
    await svc.disconnect(hostId);
    svc.hosts.delete(hostId);
    svc.passwords.delete(hostId);
    ctx.remoteFolders.delete(hostId);
    // The host's trusted workspaces go with it.
    const root = ctx.store?.root;
    if (root)
      new SshWorkspaceTrustStore(sshWorkspaceTrustFile(root)).forget(hostId);
  });

  handle("sshConnect", async (id: unknown) => ssh().connect(checkHostId(id)));

  handle("officialSshSlashCommands", async (raw: unknown, rawNames?: unknown) => {
    const target = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("draft"), hostId: z.string(), cwd: z.string().optional() }).strict(),
      z.object({ kind: z.literal("session"), conversationId: z.string().min(1).max(500) }).strict(),
    ]).parse(raw);
    const names = z.array(z.string().max(256)).optional().parse(rawNames);
    const svc = ssh(), store = ctx.store, activation = ctx.accountActivationIdentity;
    const owner = ctx.activeAccount?.id;
    if (!owner || !svc.allowed()) return null;
    const current = () => service === svc && !ctx.accountRetiring && ctx.store === store &&
      ctx.accountActivationIdentity === activation && ctx.activeAccount?.id === owner;
    let hostId: string, cwd: string | undefined;
    if (target.kind === "session") {
      const c = store.conversations.find(item => item.id === target.conversationId);
      if (!c || c.mode !== "code" || c.incognito || c.cloudHosted || c.cloudEnvironmentId ||
          c.environment?.kind !== "ssh" || c.sessionAuthors &&
          (c.sessionAuthors.ownerAccountUuid !== owner || c.sessionAuthors.viewerAccountUuid !== owner))
        throw Error("An owned SSH Code session is required.");
      ({ hostId } = c.environment);
      cwd = c.cwd;
    } else {
      try { hostId = checkHostId(target.hostId); }
      catch { return null; }
      cwd = target.cwd ? checkRemotePath(target.cwd) : undefined;
    }
    const host = svc.hosts.get(hostId);
    const connection = svc.existing(hostId);
    if (!host || !connection) return null;
    const checkCurrent = () => {
      if (!current()) throw Error("The account changed during this request.");
      return svc.allowed() && svc.existing(hostId) === connection && connection.live();
    };
    try {
      if (connection.status.state === "connecting") await connection.connect({ interactive: false });
      if (!checkCurrent() || !connection.probe) return null;
      const home = checkHostPath(connection.probe.home);
      const engine = ctx.engines.forEnvironment({ kind: "ssh", hostId });
      const folder = cwd === "~" ? home : cwd?.startsWith("~/") ? path.posix.resolve(home, cwd.slice(2)) : cwd;
      const trust = folder ? await engine.remoteWorkspaceTrust(folder, false) : undefined;
      if (!checkCurrent()) return null;
      const project = trust?.trusted ? trust.folder : undefined;
      const workspace = new RemoteWorkspace(hostId, host.label, () => {
        if (!checkCurrent()) throw new RemoteUnavailableError("The SSH host is no longer connected.");
        return connectionRunner(connection);
      });
      const rpc = engine.rpc;
      const codexSkills = rpc && engine.state.state === "ready"
        ? await rpc.call("skills/list", { cwds: [project ?? home], forceReload: true }).catch(() => undefined)
        : undefined;
      const commands = await sshSlashCommands({ workspace, home, project, names, codexSkills });
      return checkCurrent() ? { commands, project } : null;
    } catch (error) {
      if (!checkCurrent() || error instanceof RemoteUnavailableError) return null;
      throw error;
    }
  });

  handle("officialResolveSshSettings", async (id: unknown, rawCwd?: unknown, options?: unknown) => {
    const hostId = checkHostId(id);
    const folder = rawCwd == null || rawCwd === "" ? undefined : checkRemotePath(rawCwd);
    z.object({ boundedManagedSettingsWait: z.boolean().optional(), retryFailedManagedSettings: z.boolean().optional() }).optional().parse(options);
    const svc = ssh(), store = ctx.store, activation = ctx.accountActivationIdentity;
    const current = () => {
      if (service !== svc || ctx.accountRetiring || ctx.store !== store || ctx.accountActivationIdentity !== activation)
        throw Error("The account changed during this request.");
    };
    let settings: ResolvedSshSettings = {};
    try {
      allowedOrThrow();
      await svc.connect(hostId, false);
      current();
      const connection = readyConnection(svc, hostId);
      const home = connection.probe?.home;
      if (home) {
        const cwd = folder === "~" ? home : folder?.startsWith("~/") ? path.posix.resolve(home, folder.slice(2)) : folder;
        const trust = cwd ? await ctx.engines.forEnvironment({ kind: "ssh", hostId }).remoteWorkspaceTrust(cwd, false) : undefined;
        current();
        const workspace = remoteWorkspace(contextSources(ctx), hostId);
        settings = await readSshSettings(workspace.readFileInside, home, trust?.trusted ? trust.folder : undefined);
      }
    } catch {
      current();
    }
    current();
    if (settings.model) {
      const model = settings.model.value;
      const provider = codeStartProvider(store.settings);
      const remote = ctx.remote;
      const catalog = remote?.ready ? remote.modelCatalog() : null;
      if (!provider || (provider.model !== model && !provider.models.includes(model)) ||
          remote?.ready === false || (catalog && !catalog.items.some((item) => item.id === model)))
        delete settings.model;
    }
    return applySshSettingsPolicy(settings, ctx.policy());
  });

  handle("sshDisconnect", async (id: unknown) => {
    await ssh().disconnect(checkHostId(id));
  });

  handle("sshStatus", async (id: unknown): Promise<SshStatus> => {
    const connection = ssh().existing(checkHostId(id));
    return connection?.status ?? { state: "idle" };
  });

  handle("sshTestHost", async (input: unknown, interactive = true) => {
    allowedOrThrow();
    const svc = ssh();
    const value = (input ?? {}) as Record<string, unknown>;
    const saved = typeof value.id === "string" ? svc.hosts.get(checkHostId(value.id)) : undefined;
    const fields = checkHostFields({
      destination: value.destination,
      port: value.port,
      identityFile: value.identityFile,
      sshPath: value.sshPath ?? saved?.sshPath,
      forwardAgent: value.forwardAgent ?? saved?.forwardAgent,
    });
    const sshPath = svc.sshFor(fields);
    if (!sshPath)
      return { ok: false, error: errorMessage("ssh-missing", fields.label) };
    const policyError = await sshPolicyError(ctx.policy(), fields, sshPath);
    if (policyError)
      return { ok: false, code: policyError.code, error: policyError.message };
    const version = await readSshVersion(sshPath);
    if (
      (version || ctx.policy().sshClientPath) &&
      !supportedSshVersion(version)
    ) {
      const code = ctx.policy().sshClientPath
        ? "ssh-managed-unusable"
        : "ssh-too-old";
      return {
        ok: false,
        code,
        error: errorMessage(code, fields.label),
        ...(code === "ssh-managed-unusable" ? { details: sshPath } : {}),
      };
    }
    // The password typed in the form, else the saved host's.
    const password =
      typeof value.password === "string" && value.password
        ? checkSshPassword(value.password)
        : saved && saved.destination === fields.destination &&
            (saved.port ?? 22) === (fields.port ?? 22) && saved.identityFile === fields.identityFile
          ? svc.passwords.get(saved.id)
          : undefined;
    return testSshHost({
      host: fields,
      sshPath,
      askpass: await svc.askpass(),
      password,
      interactive,
    });
  });

  handle("sshForgetHostKey", async (input: unknown) => {
    allowedOrThrow();
    const svc = ssh();
    const value = (input ?? {}) as Record<string, unknown>;
    const fields = checkHostFields({
      destination: value.destination,
      port: value.port,
      sshPath: value.sshPath,
    });
    const sshPath = svc.sshFor(fields);
    if (!sshPath) throw new Error(errorMessage("ssh-missing", fields.label));
    return forgetHostKey({
      sshPath,
      destination: fields.destination,
      port: fields.port,
    });
  });

  handle("sshAnswerPrompt", async (promptId: unknown, answer: unknown) => {
    if (typeof promptId !== "string" || promptId.length > 64) return;
    if (answer !== null && typeof answer !== "string")
      throw new Error("Enter an answer.");
    const svc = ssh();
    const activation = ctx.accountActivationIdentity;
    const broker = await svc.askpass();
    if (service !== svc || ctx.accountRetiring === true || ctx.accountActivationIdentity !== activation)
      throw Error("The active account changed.");
    broker.answer(promptId, answer);
  });
  handle("officialPendingSshPrompts", async () => service ? (await service.askpass()).pending() : []);

  handle("sshListDirectory", async (hostId: unknown, folder?: unknown) => {
    allowedOrThrow();
    const connection = readyConnection(ssh(), hostId as string);
    const target =
      folder === undefined || folder === null || folder === ""
        ? undefined
        : checkRemotePath(folder);
    const result = await connection.exec(listDirectoryScript(target), {
      timeoutMs: 30_000,
    });
    const listing =
      result.code === 0 ? parseDirectoryListing(result.stdout) : undefined;
    if (!listing)
      throw new Error(
        result.code === 3
          ? "That folder doesn't exist or can't be opened."
          : `Couldn't read the folder on ${connection.host.label}.`,
      );
    return listing;
  });

  handle("sshChooseFolder", async (hostId: unknown, folder: unknown) => {
    allowedOrThrow();
    const connection = readyConnection(ssh(), hostId as string);
    const chosen = checkRemotePath(folder);
    const result = await connection.exec(folderCheckScript(chosen), {
      timeoutMs: 30_000,
    });
    const resolved =
      result.code === 0 ? parseFolderCheck(result.stdout) : undefined;
    if (!resolved)
      throw new Error("That folder doesn't exist or can't be opened.");
    const id = connection.host.id;
    const folders = ctx.remoteFolders.get(id) ?? new Set<string>();
    // The folder as it resolved (symlinks followed), and as the person
    // wrote it when that was already an absolute path.
    const add = (value: string) => {
      folders.delete(value);
      folders.add(value);
    };
    add(resolved);
    if (chosen.startsWith("/")) {
      const normal = path.posix.normalize(chosen);
      add(normal.length > 1 ? normal.replace(/\/+$/, "") : normal);
    }
    while (folders.size > MAX_REMOTE_FOLDERS)
      folders.delete(folders.values().next().value as string);
    ctx.remoteFolders.set(id, folders);
  });
}
