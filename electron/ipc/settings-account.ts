import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  activeSessionsFrom,
  parseSessionId,
} from "../../shared/active-sessions";
import type {
  AccountProfile,
  ActiveSession,
  SharedArtifact,
} from "../../shared/settings-api";
import type { HostedShare } from "../../shared/sharing-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { exportArchive } from "../conversations/data-export";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import { HistoryImporter } from "../conversations/history-import";
import { ClaudeAiImport } from "../conversations/claude-ai-import";
import { Sub2ApiError } from "../sub2api/http";

/** The service's answer while its web app is turned off (webproto.ErrCodeDisabled). */
const webAppOff = "CLAUDEX_WEB_DISABLED";

/**
 * Handlers behind Settings → Account and Privacy. Deletion uses the active
 * account session.
 */
export function registerSettingsAccountHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const profile = async (): Promise<AccountProfile> => {
    const account = ctx.activeAccount!;
    const remote = ctx.remote?.backend;
    if (!remote)
      return {
        kind: "local",
        fullName: account.name,
        email: account.email,
        canDelete: true,
      };
    const user = await remote.session.authorized((token) =>
      remote.client.profile(token),
    );
    return {
      kind: "remote",
      fullName: user.username,
      email: user.email,
      canDelete: true,
    };
  };
  handle("accountProfile", profile);
  handle("deleteStoredCodeSessions", () => {
    throw new Error("Sign in to Claudex again.");
  });
  handle("codeSharingSettings", async (raw: unknown) => {
    const patch = z
      .object({
        requireRepositoryAccess: z.boolean().optional(),
        showName: z.boolean().optional(),
      })
      .strict()
      .optional()
      .parse(raw);
    const remote = ctx.remote?.backend;
    if (!remote) throw new Error("Sign in to Claudex again.");
    return remote.session.authorized((token) =>
      remote.client.codeSharingSettings(token, patch),
    );
  });
  handle("setFullName", async (raw: unknown) => {
    const name = z.string().trim().min(1).max(100).parse(raw);
    const remote = ctx.remote?.backend;
    if (remote)
      await remote.session.authorized((token) =>
        remote.client.updateUsername(token, name),
      );
    else ctx.accounts.rename(ctx.activeAccount!.id, name);
    return profile();
  });
  handle("deleteAccount", async () => {
    const id = ctx.activeAccount?.id;
    if (!id) throw Error("Not signed in.");
    const remote = ctx.remote?.backend;
    if (remote) {
      await remote.session.authorized((token) =>
        remote.client.deleteAccount(token),
      );
      remote.session.end();
    }
    await ctx.deactivate();
    if (remote) await remote.accounts.removeDeleted(id);
    else ctx.accounts.removeSignedIn(id);
    fs.rmSync(path.join(ctx.dataRoot, "account-session.enc"), {
      force: true,
    });
    return { hasAccounts: ctx.accounts.hasAccounts };
  });
  handle("exportData", async () => {
    // Loaded here so the handlers can be tested without Electron.
    const { dialog } = await import("electron");
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(ctx.window!, {
      defaultPath: `claudex-export-${stamp}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (!result.filePath) return null;
    const archive = exportArchive({
      root: ctx.store.root,
      conversations: ctx.store.conversations,
      projects: ctx.store.projects,
      settings: ctx.publicSettings(),
    });
    fs.writeFileSync(result.filePath, archive, { mode: 0o600 });
    return result.filePath;
  });
  // Settings → Import: a Claudex export or a copied data folder. The window
  // never names a path: a location is picked here and referred to by id.
  const importer = () => new HistoryImporter(ctx.store);
  const remoteImport = new ClaudeAiImport({
    root: () => ctx.store.root,
    open: async (url) => {
      const { shell } = await import("electron");
      await shell.openExternal(url);
    },
  });
  ctx.onAccountDeactivating?.(() => remoteImport.dispose());
  handle("claudeAiImportSignIn", () => remoteImport.signIn());
  handle("claudeAiImportFetch", async () => {
    const root = ctx.store.root;
    const files = await remoteImport.download();
    if (root !== ctx.store.root)
      throw new Error("Your conversation export didn’t import");
    return Promise.all(files.map((file) => importer().add("file", file)));
  });
  handle("claudeAiImportCancel", () => remoteImport.cancel());
  handle("importSources", () => importer().sources());
  handle("importAddSource", async (raw: unknown) => {
    const kind = z.enum(["file", "folder"]).parse(raw);
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog(ctx.callerWindow()!, {
      properties:
        kind === "file" ? ["openFile"] : ["openDirectory", "createDirectory"],
      ...(kind === "file"
        ? { filters: [{ name: "ZIP archive", extensions: ["zip"] }] }
        : {}),
    });
    const picked = result.filePaths[0];
    if (!picked) return null;
    return importer().add(kind, picked);
  });
  handle("importRemoveSource", (raw: unknown) => {
    importer().removeSource(z.string().min(1).max(64).parse(raw));
  });
  handle("importRun", async (raw: unknown, since: unknown) => {
    const ids = z.array(z.string().min(1).max(64)).max(50).parse(raw);
    const from = z.number().int().min(0).parse(since);
    const result = await importer().run(ids, from);
    if (result.imported.conversations || result.imported.projects)
      ctx.push({ type: "resync" });
    return result;
  });
  handle("importHistory", () => importer().history());
  handle("importRemovePreview", (raw: unknown) =>
    importer().removePreview(z.string().min(1).max(64).parse(raw)),
  );
  handle("importRemove", async (raw: unknown) => {
    const target = z.string().min(1).max(64).parse(raw);
    const result = await importer().remove(target, async (id) => {
      await ctx.terminals?.closeConversation(id);
      ctx.replyFeedback.deleteConversation(id);
      coworkFolderGrants(ctx.store.root).forgetConversation(id);
    });
    ctx.push({ type: "resync" });
    return result;
  });
  // Account → Active sessions: the desktop devices and the browser sessions
  // of the Claudex account. An account on this computer only has none to
  // list (null). The web app being off on the service is no browser sessions.
  handle("activeSessions", async (): Promise<ActiveSession[] | null> => {
    const remote = ctx.remote?.backend;
    if (!remote) return null;
    const [devices, web, apps] = await Promise.all([
      remote.session.authorized((token) =>
        remote.client.devices(token, remote.deviceId),
      ),
      remote.session
        .authorized((token) => remote.client.webSessions(token))
        .catch((error) => {
          if (
            error instanceof Sub2ApiError &&
            (error.code === webAppOff || error.status === 404)
          )
            return null;
          throw error;
        }),
      // The phone apps' sign-ins; a service from before they were recorded
      // (404) has none to list.
      remote.session
        .authorized((token) => remote.client.nativeSessions(token))
        .catch((error) => {
          if (error instanceof Sub2ApiError && error.status === 404)
            return null;
          throw error;
        }),
    ]);
    return activeSessionsFrom(devices, web, apps);
  });
  handle("endActiveSession", async (raw: unknown) => {
    const target = parseSessionId(z.string().max(40).parse(raw));
    if (!target) throw Error("Unknown session.");
    const remote = ctx.remote?.backend;
    if (!remote)
      throw Error("Sign in to a Claudex service to manage sessions.");
    try {
      await remote.session.authorized((token) =>
        target.kind === "desktop"
          ? remote.client.revokeDevice(token, remote.deviceId, target.id)
          : target.kind === "app"
            ? remote.client.revokeNativeSession(token, target.id)
            : remote.client.revokeWebSession(token, target.id),
      );
      return { ended: true };
    } catch (error) {
      // Gone already (or never this account's): the original says so and
      // reloads the list.
      if (error instanceof Sub2ApiError && error.status === 404)
        return { ended: false };
      throw error;
    }
  });
  handle("sharedArtifacts", sharedArtifacts);
  handle("stopSharingArtifact", async (raw: unknown) => {
    const identity = z.string().min(1).max(3000000).parse(raw);
    const hostedId = /^hosted:([A-Za-z0-9_-]{1,64})$/.exec(identity)?.[1];
    if (hostedId) {
      const hosted = ctx.services.sharing?.hosted;
      if (!hosted) throw Error("Sharing isn't available on this service.");
      await hosted.revoke(hostedId);
    } else ctx.artifactShares.unshare(identity);
    ctx.push({ type: "artifact-shares", shares: ctx.artifactShares.list() });
    return sharedArtifacts();
  });
  /**
   * Privacy → Shared artifacts: the public links on the Claudex service (R1)
   * and the links on this computer. A public link's row stops that link
   * only; an artifact can have both.
   */
  async function sharedArtifacts(): Promise<SharedArtifact[]> {
    const local: SharedArtifact[] = ctx.artifactShares
      .shared()
      .map((item) => ({ ...item, scope: "local" }));
    const hosted = ctx.services.sharing?.hosted;
    if (!ctx.remote || !hosted) return local;
    let shares: HostedShare[] = [];
    try {
      if (await hosted.status()) shares = await hosted.list("artifact", true);
    } catch {
      // Unreachable: the local links still show and can be stopped.
    }
    return [
      ...shares.map((share): SharedArtifact => ({
        identity: `hosted:${share.id}`,
        title:
          share.status === "disabled"
            ? `${share.title || "Untitled artifact"} (removed by the administrator)`
            : share.title || "Untitled artifact",
        ...(share.status === "active" ? { url: share.url } : {}),
        scope: "public",
        createdAt: share.createdAt,
      })),
      ...local,
    ];
  }
}
