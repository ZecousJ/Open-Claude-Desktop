import path from "node:path";
import { SshToolGrantStore } from "../ssh/tool-grants";
import type { SshStatus } from "../../shared/ssh-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { testSshHost } from "../ssh/connection";
import { errorMessage } from "../ssh/connection-support";
import { checkHostFields, checkHostId } from "../ssh/host-store";
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
import {
  SshWorkspaceTrustStore,
  sshWorkspaceTrustFile,
} from "../workspace/workspace-trust";
import { MAX_REMOTE_FOLDERS, SshService } from "./ssh";
import type { SshServiceOptions } from "./ssh";

/** A connected host's connection, or an error the window can show. */
function readyConnection(service: SshService, hostId: string) {
  const connection = service.existing(checkHostId(hostId));
  const host = service.hosts.get(hostId);
  if (!host) throw new Error("That SSH connection no longer exists.");
  if (!connection || connection.status.state !== "ready")
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

  handle("sshDisconnect", async (id: unknown) => {
    await ssh().disconnect(checkHostId(id));
  });

  handle("sshStatus", async (id: unknown): Promise<SshStatus> => {
    const connection = ssh().existing(checkHostId(id));
    return connection?.status ?? { state: "idle" };
  });

  handle("sshTestHost", async (input: unknown) => {
    allowedOrThrow();
    const svc = ssh();
    const value = (input ?? {}) as Record<string, unknown>;
    const fields = checkHostFields({
      destination: value.destination,
      port: value.port,
      identityFile: value.identityFile,
      sshPath: value.sshPath,
      forwardAgent: value.forwardAgent,
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
        : typeof value.id === "string"
          ? svc.passwords.get(checkHostId(value.id))
          : undefined;
    return testSshHost({
      host: fields,
      sshPath,
      askpass: await svc.askpass(),
      password,
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
    (await ssh().askpass()).answer(promptId, answer);
  });

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
