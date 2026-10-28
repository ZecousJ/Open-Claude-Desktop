import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Conversation, Mode } from "../../shared/types";
import {
  workspaceTrustMessage,
  type WorkspaceTrust,
} from "../../shared/workspace-trust-api";
import { WorkspaceTrustStore, realFolder } from "../workspace/workspace-trust";
import { registryOf } from "../engine/engine-registry";

declare module "../app/app-context" {
  interface AppServices {
    /** Code's workspace trust (desktop only; the runner trusts its sandboxes). */
    workspaceTrust?: WorkspaceTrustGate;
  }
}

const folderPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), "Choose an absolute folder.");

/** An SSH host (a folder on this computer leaves it out). */
const trustPlace = z
  .object({ kind: z.literal("ssh"), hostId: z.string().min(1).max(128) })
  .strict()
  .optional();
/** A folder on an SSH host; empty for the host's default folder. */
const remoteFolder = z
  .string()
  .max(4096)
  .refine(
    (value) => value === "" || value.startsWith("/"),
    "Choose an absolute folder.",
  );

/** What a send is checked against (electron/ipc/conversations.ts). */
export interface WorkspaceTrustGate {
  /**
   * Refuses a Code turn on this computer in a folder Codex doesn't trust
   * with `workspaceTrustMessage`. The engine's own workspace (a session
   * without a folder) is the app's, so it never asks.
   */
  assert(input: {
    mode: Mode | "";
    conversation?: Pick<Conversation, "mode" | "cwd" | "environment">;
    cwd?: string;
  }): void;
  /**
   * Trusts a folder's Codex project without asking: a Cowork folder the
   * person allowed is trusted for Code too, as the official Cowork trust
   * does. Never fails the caller; the reason is logged.
   */
  trust(folder: string): Promise<void>;
}

/**
 * The default workspace or a folder inside it (a folderless session's own
 * folder, `workspace/sessions/<id>`): Claudex's own, never asked about.
 */
function insideDefault(folder: string, workspace: string) {
  const relative = path.relative(realFolder(workspace), realFolder(folder));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** The check of `WorkspaceTrustGate.assert`, apart from the IPC (tests). */
export function workspaceTrustGate(
  store: Pick<WorkspaceTrustStore, "check" | "trust">,
  defaultWorkspace: () => string,
  changed: () => void = () => {},
): WorkspaceTrustGate {
  return {
    async trust(folder) {
      try {
        if (insideDefault(folder, defaultWorkspace())) return;
        if (store.check(folder).trusted) return;
        await store.trust(folder);
        changed();
      } catch (error) {
        console.error(
          "Workspace trust:",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    assert({ mode, conversation, cwd }) {
      const codeMode = conversation ? conversation.mode : mode;
      if (codeMode !== "code") return;
      if ((conversation?.environment?.kind ?? "local") !== "local") return;
      const folder = conversation ? conversation.cwd : cwd;
      if (!folder) return;
      if (insideDefault(folder, defaultWorkspace())) return;
      if (!store.check(folder).trusted) throw new Error(workspaceTrustMessage);
    },
  };
}

/**
 * Workspace trust (shared/workspace-trust-api.ts): Code's "Trust this
 * workspace?" records the choice in the local engine's Codex config, and
 * Settings → Claude Code → Trusted folders lists and removes it. Desktop
 * only: on the web runner the methods are absent and the engine trusts its
 * sandbox's folders itself (`Engine.trustEveryWorkspace`).
 */
export function registerWorkspaceTrustHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  desktop = Boolean(process.versions.electron),
) {
  if (!desktop) return;
  const store = new WorkspaceTrustStore(() => ctx.engine);
  const changed = () => ctx.push?.({ type: "workspace-trust" });
  ctx.services.workspaceTrust = workspaceTrustGate(
    store,
    () => ctx.engine.defaultWorkspace,
    changed,
  );
  /** An SSH host's engine (it checks and records the host's trust). */
  const hostEngine = (place: { kind: "ssh"; hostId: string }) => {
    const registry = registryOf(ctx.engine);
    if (!registry) throw new Error("SSH connections aren't available.");
    return { registry, engine: registry.forEnvironment(place) };
  };
  handle(
    "checkWorkspaceTrust",
    async (raw: unknown, rawPlace?: unknown): Promise<WorkspaceTrust> => {
      const place = trustPlace.parse(rawPlace ?? undefined);
      if (!place) return store.check(folderPath.parse(raw));
      return hostEngine(place).engine.remoteWorkspaceTrust(
        remoteFolder.parse(raw) || undefined,
      );
    },
  );
  handle("saveWorkspaceTrust", async (raw: unknown, rawPlace?: unknown) => {
    const place = trustPlace.parse(rawPlace ?? undefined);
    if (place) {
      const folder = remoteFolder.parse(raw) || undefined;
      const { registry, engine } = hostEngine(place);
      // Only a folder the person chose there (or the host's default).
      registry.allowedFolder(folder, place);
      return engine.trustRemoteWorkspace(folder);
    }
    const folder = folderPath.parse(raw);
    // Only a folder the person chose or already works in.
    ctx.allowedFolder(folder);
    await store.trust(folder);
    changed();
    return store.check(folder);
  });
  handle("trustedWorkspaces", async () => store.list());
  handle("addTrustedWorkspace", async () => {
    const { dialog } = await import("electron");
    const parent = ctx.callerWindow?.() ?? ctx.window;
    const options = {
      properties: ["openDirectory", "createDirectory"] as (
        "openDirectory" | "createDirectory"
      )[],
      buttonLabel: "Trust Folder",
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const folder = result.canceled ? undefined : result.filePaths[0];
    // Choosing the folder in Settings is the person's explicit trust.
    if (folder) {
      ctx.selectedFolders.add(folder);
      await store.trust(folder);
      changed();
    }
    return store.list();
  });
  handle("removeTrustedWorkspace", async (raw: unknown) => {
    await store.remove(folderPath.parse(raw));
    changed();
    return store.list();
  });
}
