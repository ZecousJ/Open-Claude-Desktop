import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Conversation } from "../../shared/types";
import type { CoworkFolderAccess } from "../../shared/cowork-api";
import {
  coworkFolderGrants,
  type CoworkFolderGrants,
} from "../workspace/cowork-folders";
import { protectCoworkFolders } from "../workspace/cowork-folders-support";
import { preference } from "../../shared/settings-extras";
import { isPackageFolder } from "../workspace/package-folder";
import { registerCoworkExtension } from "../connectors/cowork-extension";
import {
  listProjectFolder,
  readProjectFile,
  resolveInside,
} from "../projects/project-files";
import { latestGeneratedFiles } from "../../shared/generated-files";
import { snapshotChosenFile } from "../artifacts/generated-files";
import { GeneratedBlobs } from "../artifacts/generated-blobs";
import {
  readFolderInstructions,
  writeFolderInstructions,
} from "../engine/cowork-instructions";

declare module "../app/app-context" {
  /** R11-A: read by the engine's Cowork extension (added folders, R11-D). */
  interface CoworkFoldersSlot extends Pick<
    CoworkFolderGrants,
    "access" | "extraFolders" | "routineAllowed"
  > {}
}

const conversationId = z.string().min(1).max(128);
const folderPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), "Choose an absolute folder.");
const target = z
  .object({
    conversationId: conversationId.optional(),
    routineId: z.string().min(1).max(128).optional(),
    // A project's Folder section (shared/project-folders.ts).
    projectId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.conversationId, value.routineId, value.projectId].filter(Boolean)
        .length <= 1,
    "Choose a task, a routine or a project, not more than one.",
  )
  .optional();

/**
 * Cowork folder access (R11, shared/cowork-api.ts). The window asks here
 * whether Cowork may use a folder and records the person's answer in the
 * access dialog; the grants themselves live in `electron/cowork-folders.ts`
 * and the send check in `electron/ipc/conversations.ts` enforces them. Only
 * folders the person chose with a picker (or already uses) can be granted:
 * a path typed into the page is refused by `allowedFolder`.
 */
export function registerCoworkHandlers(handle: IpcHandle, ctx: AppContext) {
  handle("listCoworkDevices", () => []);
  // Tokens, device keys and every profile live under userData.
  if (ctx.dataRoot) protectCoworkFolders(ctx.dataRoot);
  const grants = () => coworkFolderGrants(ctx.store.root);
  ctx.onAccountActivated?.(() => {
    const current = grants();
    try {
      current.ensureLoaded();
    } catch (error) {
      console.error(
        "Cowork folders:",
        error instanceof Error ? error.message : String(error),
      );
    }
    ctx.services.coworkFolders = current;
  });
  ctx.onAccountDeactivating?.(() => {
    delete ctx.services.coworkFolders;
  });
  // R11-D: the engine gives a task's added folders to Codex.
  registerCoworkExtension(ctx);
  const coworkConversation = (raw: unknown): Conversation => {
    const found = ctx.store.conversations.find(
      (c) => c.id === conversationId.parse(raw),
    );
    if (!found || (found.mode !== "cowork" && found.mode !== "chat"))
      throw new Error("Task conversation not found.");
    return found;
  };
  const supportsTaskFolders = (conversation: Conversation) =>
    (conversation.mode === "cowork" ||
      (conversation.mode === "chat" &&
        preference(ctx.store.settings, "computerAccess"))) &&
    conversation.environment?.kind !== "ssh" &&
    !(
      conversation.environment?.kind === "space" &&
      !/^[A-Za-z0-9_-]{1,80}$/.test(conversation.environment.spaceId)
    ) &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding;
  const executionBrowser = (conversation: Conversation) => {
    if (!supportsTaskFolders(conversation))
      throw new Error("Folder access is unavailable for this session.");
    return grants().executionBrowser(conversation);
  };
  const checkFolder = (folder: string, conversation?: Conversation) => {
    if (
      conversation &&
      ctx.store.conversations.find((item) => item.id === conversation.id) !==
        conversation
    )
      throw new Error("This task session changed. Try again.");
    if (conversation && !supportsTaskFolders(conversation))
      throw new Error("Folder access is unavailable for this session.");
    if (conversation?.environment?.kind === "space")
      return executionBrowser(conversation).checked(folder);
    // Network clients may never use native picker grants or another task's
    // root. Only the execution-space branch above accepts remote paths.
    if (ctx.connectors)
      throw new Error("Folder access is unavailable for this session.");
    ctx.allowedFolder(folder);
    return folder;
  };
  const folderAccess = (
    folder: string,
    conversation?: Conversation,
    project?: string,
  ): CoworkFolderAccess => {
    const access = grants().access(folder, conversation?.id, project);
    if (
      conversation?.environment?.kind !== "space" ||
      access.state !== "default"
    )
      return access;
    const own = [conversation.cwd, ...grants().extraFolders(conversation.id)];
    // A subfolder is already inside the sandbox, but the person still
    // confirms before adding it to the model's task context.
    return {
      ...access,
      state: own.includes(access.folder) ? "granted" : "ask",
    };
  };
  /** A project of this profile, by id. */
  const knownProject = (raw: unknown): string => {
    const id = z.string().min(1).max(128).parse(raw);
    if (!ctx.store.projects.some((project) => project.id === id))
      throw new Error("This project no longer exists.");
    return id;
  };
  const changed = (conversationId?: string) =>
    ctx.push?.({
      type: "cowork-folders",
      ...(conversationId ? { conversationId } : {}),
    });

  handle(
    "coworkFolderAccess",
    async (
      rawFolder: unknown,
      rawId?: unknown,
      rawProject?: unknown,
    ): Promise<CoworkFolderAccess> => {
      const folder = folderPath.parse(rawFolder);
      const conversation =
        rawId === undefined || rawId === null
          ? undefined
          : coworkConversation(rawId);
      const project =
        rawProject === undefined ? undefined : knownProject(rawProject);
      const checked = checkFolder(folder, conversation);
      return folderAccess(checked, conversation, project);
    },
  );
  handle(
    "grantCoworkFolder",
    async (
      rawFolder: unknown,
      rawScope: unknown,
      rawTarget?: unknown,
    ): Promise<CoworkFolderAccess> => {
      const folder = folderPath.parse(rawFolder);
      const scope = z.enum(["session", "always"]).parse(rawScope);
      const to = target.parse(rawTarget ?? undefined);
      const conversation = to?.conversationId
        ? coworkConversation(to.conversationId)
        : undefined;
      if (to?.routineId) {
        const routine = ctx.scheduler
          ?.list()
          .find((task) => task.id === to.routineId);
        if (!routine || routine.mode !== "cowork")
          throw new Error("This Cowork task no longer exists.");
      }
      const project = to?.projectId ? knownProject(to.projectId) : undefined;
      // Only a folder chosen with the picker, or one already in use.
      const checked = checkFolder(folder, conversation);
      const store = grants();
      const current = folderAccess(checked, conversation, project);
      if (current.state === "refused") throw new Error(current.reason);
      // The app's own workspace needs no permission.
      if (current.state === "default") return current;
      if (scope === "always" && conversation?.environment?.kind === "space")
        throw new Error(
          "Execution folders can only be allowed for this session.",
        );
      if (scope === "always") store.trust(checked);
      // The project's tasks get the folder, whichever way it was allowed.
      if (project) store.grantProject(project, folder);
      else if (conversation?.environment?.kind === "space")
        store.grantExecutionConversation(conversation, checked);
      else if (conversation) store.grantConversation(conversation, checked);
      else if (scope === "session" && to?.routineId)
        store.grantRoutine(to.routineId, folder);
      else if (scope === "session" && current.state === "ask")
        store.allowOnce(folder);
      changed(conversation?.id);
      if (conversation) ctx.push?.({ type: "conversation", conversation });
      // Allowing a folder for Cowork also trusts it in Codex (the official
      // Cowork trust covers Code there too), so its .codex config loads.
      if (conversation?.environment?.kind !== "space")
        await ctx.services.workspaceTrust?.trust(folder);
      // Recheck the execution root after the asynchronous trust operation.
      checkFolder(folder, conversation);
      return folderAccess(checked, conversation, project);
    },
  );
  handle("coworkFolders", async (raw: unknown) => {
    const found = coworkConversation(raw);
    const result = {
      ...(found.cwd ? { primary: found.cwd } : {}),
      extra: grants().extraFolders(found.id),
    };
    if (!supportsTaskFolders(found)) return result;
    if (found.environment?.kind === "space") {
      // A supported space whose workspace cannot be read is an error,
      // with a retry in the composer. Never disguise it as no folders.
      return {
        ...result,
        browser: executionBrowser(found).capability(found.cwd),
      };
    }
    if (!ctx.connectors)
      return { ...result, browser: { kind: "native" as const } };
    return result;
  });
  handle(
    "listTaskFolderDirectory",
    async (rawId: unknown, rawPath: unknown) => {
      const found = coworkConversation(rawId);
      return executionBrowser(found).list(folderPath.parse(rawPath));
    },
  );
  const resourceRoot = (rawId: unknown, rawIndex: unknown) => {
    const found = coworkConversation(rawId);
    if (found.environment?.kind === "ssh")
      throw new Error("This conversation's folder is on an SSH host.");
    const folders = [
      ...new Set(
        [found.cwd, ...grants().extraFolders(found.id)].filter(
          (folder): folder is string => Boolean(folder),
        ),
      ),
    ];
    const root = folders[z.number().int().min(0).parse(rawIndex)];
    if (!root) throw new Error("This folder isn't part of this task.");
    if (!supportsTaskFolders(found))
      throw new Error("Folder access is unavailable for this session.");
    if (found.environment?.kind === "space")
      executionBrowser(found).checked(root);
    else if (ctx.connectors) ctx.allowedFolder(fs.realpathSync(root));
    return root;
  };
  handle(
    "listCoworkFolder",
    async (id: unknown, index: unknown, relative: unknown) => {
      const result = listProjectFolder(
        resourceRoot(id, index),
        z.string().max(4096).parse(relative),
      );
      // Desktop listFilesInFolderImpl.
      result.entries = result.entries.filter(
        ({ name }) =>
          !name.startsWith(".") &&
          !name.startsWith("~$") &&
          !(name.startsWith("~") && name.toLowerCase().endsWith(".tmp")) &&
          ![
            "thumbs.db",
            "ehthumbs.db",
            "desktop.ini",
            "__macosx",
            "icon\r",
          ].includes(name.toLowerCase()),
      );
      return result;
    },
  );
  handle("readCoworkInstructions", async (id: unknown) =>
    readFolderInstructions(resourceRoot(id, 0)),
  );
  handle("writeCoworkInstructions", async (id: unknown, content: unknown) => {
    writeFolderInstructions(resourceRoot(id, 0), z.string().parse(content));
  });
  const previewFile = (root: string, relative: string) => {
    const target = resolveInside(root, relative);
    const snapshot = snapshotChosenFile(
      target,
      new GeneratedBlobs(ctx.store.root),
    );
    return snapshot.state === "ready"
      ? { path: relative, bytes: snapshot.bytes ?? 0, snapshot }
      : readProjectFile(root, relative);
  };
  handle(
    "readCoworkFile",
    async (id: unknown, index: unknown, relative: unknown) =>
      previewFile(
        resourceRoot(id, index),
        z.string().min(1).max(4096).parse(relative),
      ),
  );
  const recordedResource = (id: unknown, rawFile: unknown) => {
    const found = coworkConversation(id);
    if (found.environment?.kind === "ssh")
      throw new Error("This conversation's folder is on an SSH host.");
    const file = folderPath.parse(rawFile);
    const generated = latestGeneratedFiles(found.turns).get(file);
    const recorded = generated
      ? generated.state !== "deleted"
      : found.turns.some((turn) =>
          turn.items.some(
            (item) =>
              item.type === "commandExecution" &&
              !["failed", "interrupted", "inProgress"].includes(
                item.lifecycleStatus ?? item.status ?? "",
              ) &&
              item.success !== false &&
              !item.error &&
              (Array.isArray(item.commandActions)
                ? item.commandActions
                : []
              ).some(
                (action) =>
                  action.type === "read" &&
                  typeof action.path === "string" &&
                  path.resolve(item.cwd ?? found.cwd ?? "", action.path) ===
                    file,
              ),
          ),
        );
    if (!recorded) throw new Error("This file isn't part of this task.");
    if (found.mode === "chat" && !supportsTaskFolders(found))
      throw new Error("Folder access is unavailable for this session.");
    if (found.environment?.kind === "space")
      executionBrowser(found).checked(path.dirname(file));
    else if (ctx.connectors)
      ctx.allowedFolder(fs.realpathSync(path.dirname(file)));
    return file;
  };
  handle("readCoworkResource", async (id: unknown, rawFile: unknown) => {
    const file = recordedResource(id, rawFile);
    return previewFile(path.dirname(file), path.basename(file));
  });
  handle("revealCoworkResource", async (id: unknown, rawFile: unknown) => {
    const file = recordedResource(id, rawFile);
    const target = resolveInside(path.dirname(file), path.basename(file));
    const { shell } = await import("electron");
    shell.showItemInFolder(target);
  });
  handle(
    "revealCoworkFile",
    async (id: unknown, index: unknown, relative: unknown) => {
      const file = resolveInside(
        resourceRoot(id, index),
        z.string().min(1).max(4096).parse(relative),
      );
      const { shell } = await import("electron");
      shell.showItemInFolder(file);
    },
  );
  handle("trustedCoworkFolders", async () => grants().trusted());
  handle("addTrustedCoworkFolder", async () => {
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
      grants().trust(folder);
      changed();
      await ctx.services.workspaceTrust?.trust(folder);
    }
    return grants().trusted();
  });
  handle("removeTrustedCoworkFolder", async (raw: unknown) => {
    grants().untrust(folderPath.parse(raw));
    changed();
    return grants().trusted();
  });
  handle(
    "revealCoworkFolder",
    async (rawId: unknown, rawFolder: unknown): Promise<void> => {
      const conversation = coworkConversation(rawId);
      const store = grants();
      const wanted = store.normalize(folderPath.parse(rawFolder));
      const own = [conversation.cwd, ...store.extraFolders(conversation.id)]
        .filter((value): value is string => Boolean(value))
        .map((value) => store.normalize(value))
        .filter((value): value is string => Boolean(value));
      // Only one of the task's own folders, never a path from the page.
      if (!wanted || !own.includes(wanted))
        throw new Error("This folder isn't part of this task.");
      if (!fs.statSync(wanted).isDirectory())
        throw new Error("This folder no longer exists.");
      const { shell } = await import("electron");
      // A macOS package (an .app bundle is a folder too) would launch; select it instead.
      if (isPackageFolder(wanted)) return shell.showItemInFolder(wanted);
      const failure = await shell.openPath(wanted);
      if (failure) throw new Error(failure);
    },
  );
}
