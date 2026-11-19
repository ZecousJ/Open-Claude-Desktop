import { app, dialog, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { projectTemplateInput } from "../../shared/project-creation";
import { projectToolsInput } from "../../shared/project-tools-input";
import { canDeleteOwnedChatProject, ownedProjectCapabilities } from "../../shared/project-access";
import { prepareProjectContext } from "../projects/project-create-context";
import { ProjectKnowledgeStore } from "../projects/project-knowledge";
import type { AppEvent, Attachment, EnvironmentRef, Project } from "../../shared/types";
import type { Store } from "../store/store";
import type { EngineRegistry } from "../engine/engine-registry";
import { isPackageFolder } from "../workspace/package-folder";
import { projectSearchMaxResults } from "../../shared/project-files";
import {
  listProjectFolder,
  readProjectFile,
  searchProjectFiles,
  writeProjectFile,
  projectFileLimit,
} from "../projects/project-files";
import { installedEditors, openFileInEditor, openInEditor } from "../workspace/editors";
import { checkedFilePath, identifyLocalFile, sessionRoots } from "../workspace/editor-path";
import { sshEditorWorkspace } from "../workspace/editor-ssh-file";
import type { SshServiceApi } from "./ssh";
import { SshHostStore } from "../ssh/host-store";
import { editorKinds } from "../../shared/editors";
import { conversationMarkdown } from "../conversations/data-export";
import { exportSessionArchive } from "../conversations/session-export";
import { environmentInput, requireWslWorkspaceTrust, wslEnvironmentInput } from "../workspace/workspace-fs";
import { wslFolderPath, wslFolderUnc } from "../wsl/paths";
import { listWslDistros } from "../wsl/wsl";
import { checkHostPath } from "../ssh/remote-workspace";
import {
  projectFolderLimit,
  projectFolders,
} from "../../shared/project-folders";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import { countLines } from "../../shared/attachment-detail";
import {
  copyProjectCreationFiles,
  createProjectFolder,
  importChatProjects,
} from "../projects/project-create";
import {
  attachmentKind,
  imageAttachmentTypes,
  type ClientPolicy,
} from "../../shared/client-policy";
import { attachmentRefusal } from "../../shared/client-policy-rules";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  readonly store: Store;
  readonly activeAccount?: { id: string };
  readonly accountActivationIdentity?: unknown;
  readonly window: BrowserWindow | undefined;
  selectedFolders: Set<string>;
  remoteFolders?: Map<string, Set<string>>;
  engines?: EngineRegistry;
  services?: { ssh?: SshServiceApi };
  selectedAttachments: Map<string, Attachment>;
  /** A folder counts only in its own environment (R9). */
  allowedFolder: (folder?: string, environment?: EnvironmentRef) => void;
  policy(): ClientPolicy;
  push?(event: AppEvent): void;
  /** Where the SSH hosts are kept (Open in ▸ an editor over SSH). */
  readonly dataRoot?: string;
}
const string = z.string().min(1).max(500);
const nativeEditorRequest = z.strictObject({
  target: z.string().min(1).max(4096),
  line: z.number().int().positive().max(1e7).optional(),
  ssh: z.strictObject({
    hostId: z.string(), sshHost: z.string(), sshPort: z.number().int().optional(),
    sshIdentityFile: z.string().optional(),
  }).optional(),
  current: z.custom<() => boolean>(value => typeof value === "function"),
});
export function registerWorkspaceHandlers(handle: Handle, context: Context) {
  handle("readProject", (raw: unknown) => {
    const projectId = string.parse(raw);
    const project = context.store.projects.find(
      (item) => item.id === projectId,
    );
    return project
      ? {
          status: "ready",
          project: {
            ...project,
            capabilities: ownedProjectCapabilities(project),
          },
        }
      : { status: "missing" };
  });
  handle("projectCreationCapabilities", () => ({
    routing: "classic",
    contextFiles: true,
    contextText: false,
    localFolders: context.window !== undefined,
    educationSuggestions: false,
  }));
  const exportedSessions = new Set<string>();
  handle("revealConversationExport", (rawFile: unknown) => {
    const file = z.string().min(1).max(32768).parse(rawFile);
    if (!exportedSessions.has(file))
      throw Error("This file was not exported by this window.");
    if (!fs.existsSync(file)) return false;
    shell.showItemInFolder(file);
    return true;
  });
  handle("saveProject", (raw: any, creation?: unknown) => {
    const p = z
      .object({
        id: string,
        kind: z.enum(["chat", "local", "code"]).optional(),
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000),
        instructions: z.string().max(100000),
        template: projectTemplateInput.optional(),
        tools: projectToolsInput.optional(),
        cwd: z.string().optional(),
        // The project's other folders (shared/project-folders.ts).
        additionalFolders: z
          .array(z.string().min(1).max(4096))
          .max(projectFolderLimit - 1)
          .optional(),
        createdAt: z.number(),
        // A project whose Code conversations run on an SSH host (R9).
        environment: environmentInput.optional(),
        pinned: z.boolean().optional(),
        icon: z.string().max(100).optional(),
        color: z.string().max(100).optional(),
        defaultModel: z.string().max(500).optional(),
        defaultProviderId: z.string().max(500).optional(),
        defaultEffort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional(),
        isStarterProject: z.boolean().optional(),
        archivedAt: z.number().optional(),
      })
      .parse(raw) as Project;
    const storedProject = context.store.projects.find(
      (project) => project.id === p.id,
    );
    if (
      storedProject &&
      !ownedProjectCapabilities(storedProject).canEditInstructions &&
      p.instructions !== storedProject.instructions
    )
      throw new Error("Project instructions are read-only.");
    // The parsed renderer object cannot add or expand host-owned rights.
    p.capabilities = storedProject
      ? ownedProjectCapabilities(storedProject)
      : { canEditInstructions: true, canEditKnowledgeBase: true };
    p.creationReceipt = storedProject?.creationReceipt;
    const creationInput =
      creation === undefined
        ? undefined
        : z
            .object({
              location: z.string().min(1).max(4096).optional(),
              files: z
                .array(
                  z.object({
                    name: z.string().min(1).max(255),
                    data: z
                      .instanceof(Uint8Array)
                      .refine((value) => value.byteLength <= 10_000_000),
                  }),
                )
                .max(200),
              projectIds: z
                .array(z.string().min(1).max(100))
                .min(1)
                .max(200)
                .optional(),
              operationId: z.string().min(1).max(200).optional(),
              context: z
                .object({
                  files: z
                    .array(
                      z.object({
                        name: z.string().min(1).max(255),
                        data: z
                          .instanceof(Uint8Array)
                          .refine((value) => value.byteLength <= 10_000_000),
                      }),
                    )
                    .max(200)
                    .refine(
                      (files) =>
                        files.reduce(
                          (sum, file) => sum + file.data.byteLength,
                          0,
                        ) <= 100_000_000,
                    ),
                  text: z.string().max(10_000_000).optional(),
                })
                .optional(),
            })
            .parse(creation);
    const initialContext = creationInput?.context;
    if (initialContext) {
      if (
        creationInput?.location ||
        creationInput?.projectIds ||
        creationInput?.files.length ||
        p.cwd ||
        (p.kind && p.kind !== "chat")
      )
        throw new Error(
          "Failed to prepare project context. You can try again.",
        );
      const hashing = createHash("sha256").update(
        JSON.stringify({
          project: { ...p, creationReceipt: undefined },
          files: initialContext.files.map((file) => ({
            name: file.name,
            bytes: file.data.byteLength,
          })),
          text: initialContext.text,
        }),
      );
      for (const file of initialContext.files) hashing.update(file.data);
      const digest = hashing.digest("hex");
      if (storedProject) {
        if (
          creationInput?.operationId &&
          storedProject.creationReceipt?.operationId ===
            creationInput.operationId &&
          storedProject.creationReceipt.digest === digest
        )
          return storedProject;
        throw new Error("Project context already exists.");
      }
      if (creationInput?.operationId)
        p.creationReceipt = { operationId: creationInput.operationId, digest };
    }
    if (p.environment?.kind !== "ssh") delete p.environment;
    if (creationInput !== undefined && !initialContext) {
      p.kind = "local";
      const { location, files, projectIds } = creationInput;
      const existing = context.store.projects.find(
        (project) => project.id === p.id,
      );
      if (projectIds) {
        if (
          existing ||
          !location ||
          files.length ||
          p.environment ||
          p.additionalFolders?.length
        )
          throw new Error("Failed to create project. You can try again.");
        context.allowedFolder(location);
        Object.assign(
          p,
          importChatProjects(
            context.store.root,
            context.store.projects,
            projectIds,
            location,
            p.name,
          ),
        );
        context.selectedFolders.add(p.cwd!);
      } else if (existing) p.cwd = existing.cwd;
      else if (location) {
        context.allowedFolder(location);
        p.cwd = createProjectFolder(location, p.name);
        context.selectedFolders.add(p.cwd);
      }
      context.allowedFolder(p.cwd, p.environment);
      // A new Cowork project starts pinned, however it was made (live
      // claude.ai bundle, 2026-10-14, c259d3b84: setStarred on create).
      if (!existing) p.pinned = true;
      if (!existing && files.length && p.cwd) {
        try {
          copyProjectCreationFiles(p.cwd, files);
        } catch (error) {
          if (location) {
            context.selectedFolders.delete(p.cwd);
            fs.rmdirSync(p.cwd);
          }
          throw error;
        }
      }
    }
    context.allowedFolder(p.cwd, p.environment);
    // More folders need a first one; each was chosen with the picker.
    const more = p.cwd
      ? [...new Set(p.additionalFolders ?? [])].filter(
          (folder) => folder !== p.cwd,
        )
      : [];
    for (const folder of more) context.allowedFolder(folder, p.environment);
    if (more.length) p.additionalFolders = more;
    else delete p.additionalFolders;
    const savedStore = context.store;
    const activation = context.accountActivationIdentity;
    const current = () => context.store === savedStore && context.accountActivationIdentity === activation;
    const save = (
      prepared?: Awaited<ReturnType<typeof prepareProjectContext>>,
    ) => {
      if (!current()) {
        prepared?.rollback();
        throw new Error("The signed-in account changed. Try again.");
      }
      const projectsBefore = savedStore.projects;
      const previous = projectsBefore.find((value) => value.id === p.id);
      if (prepared && previous) {
        prepared.rollback();
        if (
          p.creationReceipt &&
          previous.creationReceipt?.operationId === p.creationReceipt.operationId &&
          previous.creationReceipt.digest === p.creationReceipt.digest
        )
          return previous;
        throw new Error("Project context already exists.");
      }
      // Project visibility has no renderer mutation API. Edits preserve imported metadata.
      p.visibility =
        previous && Object.hasOwn(previous, "visibility")
          ? previous.visibility
          : "private";
      if (previous) p.template = previous.template;
      if (!previous && (p.kind ?? "chat") === "chat") {
        const saved = savedStore.persistProjectCreation(p, current, prepared);
        const publish = (project: Project) => {
          if (!current()) throw Error("The signed-in account changed. Try again.");
          context.push?.({ type: "resync" });
          return project;
        };
        return saved instanceof Promise ? saved.then(publish) : publish(saved);
      }
      const before = previous ? projectFolders(previous) : [];
      try {
        prepared?.commit();
        savedStore.projects = previous
          ? projectsBefore.map((value) => value === previous ? p : value)
          : [...projectsBefore, p];
        savedStore.flush();
      } catch (error) {
        savedStore.projects = projectsBefore;
        prepared?.rollback();
        throw error;
      }
      const kept = projectFolders(p);
      const gone = before.filter((folder) => !kept.includes(folder));
      if (gone.length) releaseProjectFolders(p.id, gone);
      const confirmation = savedStore.confirmProjectSave(p, current);
      const publish = () => { context.push?.({ type: "resync" }); return p; };
      return confirmation ? confirmation.then(publish) : publish();
    };
    return initialContext
      ? prepareProjectContext(savedStore.root, p, initialContext).then(save)
      : save();
  });
  const releaseProjectFolders = (projectId: string, folders?: string[]) => {
    try {
      const grants = coworkFolderGrants(context.store.root);
      if (!folders) grants.releaseProject(projectId);
      else
        for (const folder of folders) grants.releaseProject(projectId, folder);
    } catch (error) {
      // The project itself is saved; a grants file that can't be read stays as it was.
      console.error(
        "Project folders:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  handle("deleteProject", (raw: unknown) => {
    if (raw && typeof raw === "object") {
      const { id } = z.object({ id: string, mode: z.literal("cascade") }).strict().parse(raw);
      const store = context.store;
      const activation = context.accountActivationIdentity;
      const current = () => context.store === store && context.accountActivationIdentity === activation;
      const project = store.projects.find(row => row.id === id);
      if (!project || !canDeleteOwnedChatProject(project)) throw Error("Project not found.");
      if (store.conversations.some(row =>
        row.projectId === id && row.mode !== "code" && row.turns.some(turn => turn.status === "inProgress")))
        throw Error("Stop the project sessions first.");
      const release = store.reserveProjectDeletion(id);
      const removed = store.conversations.filter(row => row.projectId === id && row.mode !== "code");
      return store.deleteProjectWithChats(project, current).then(() => {
        if (!current()) throw Error("The account changed during this request.");
        try {
          new ProjectKnowledgeStore(store.root, () => store.projects).pruneDeletedProject(id);
          const grants = coworkFolderGrants(store.root);
          for (const row of removed) grants.forgetConversation(row.id);
        } catch {
          console.warn("Deleted project data needs cleanup.");
        }
        releaseProjectFolders(id);
        for (const row of removed)
          if (row.mode === "cowork")
            context.push?.({ type: "cowork-session-deleted", conversationId: row.id });
        context.push?.({ type: "resync" });
      }).finally(release);
    }
    const id = string.parse(raw);
    const store = context.store;
    if (store.isProjectDeleting(id)) throw Error("This project is being deleted.");
    store.assertProjectDeletionAllowed(id);
    const projects = store.projects;
    const linked = store.conversations.filter((row) => row.projectId === id);
    store.projects = projects.filter((project) => project.id !== id);
    for (const row of linked) row.projectId = undefined;
    try {
      store.flush();
    } catch (error) {
      store.projects = projects;
      for (const row of linked) row.projectId = id;
      throw error;
    }
    const publish = () => {
      if (context.store !== store) throw Error("The account changed during this request.");
      releaseProjectFolders(id);
      context.push?.({ type: "resync" });
    };
    const confirmed = store.confirmProjectDeletion(id, () => context.store === store);
    return confirmed ? confirmed.then(publish) : publish();
  });
  // Only a Code or Cowork task's own working folder can be opened, never a path from the page.
  handle("revealConversationFolder", async (id: any) => {
    const c = context.store.conversation(string.parse(id));
    // An SSH session's folder is on the host (R9): nothing to open here, and
    // the same path on this computer is a different folder.
    if (c.environment?.kind === "ssh")
      throw Error("This conversation's folder is on an SSH host.");
    if (c.mode === "chat" || !c.cwd || !fs.statSync(c.cwd).isDirectory())
      throw Error("This conversation has no working folder.");
    // A macOS package (an .app bundle is a folder too) would launch; select it instead.
    if (isPackageFolder(c.cwd)) return shell.showItemInFolder(c.cwd);
    const failure = await shell.openPath(c.cwd);
    if (failure) throw Error(failure);
  });
  // Show in Finder: only a file inside a local Code session's own folder.
  handle("revealConversationFile", async (id: any, rawFile: unknown) => {
    const c = context.store.conversation(string.parse(id));
    const file = string.parse(rawFile);
    if (c.mode !== "code" || c.environment?.kind === "ssh" || !c.cwd)
      throw Error("This file isn't in a folder on this computer.");
    const target = path.resolve(c.cwd, file);
    const relative = path.relative(path.resolve(c.cwd), target);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("This file is outside the session's folder.");
    if (!fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
  // The Files pane: a Code session's folder, read inside it only: a local
  // session's here, a cloud session's (its space) on the runner, which runs
  // these handlers for the web and the desktop app's cloud sessions.
  const projectRoot = (id: unknown, options: { write?: boolean } = {}) => {
    const c = context.store.conversation(string.parse(id));
    const kind = c.environment?.kind ?? "local";
    if (
      c.mode !== "code" ||
      !(kind === "local" || (kind === "space" && !options.write)) ||
      !c.cwd
    )
      throw Error("This session's files aren't on this computer.");
    return !options.write && c.worktree?.state === "deleted" ? c.worktree.origin : c.cwd;
  };
  // A local draft can reuse a folder grant or an existing local workspace.
  const projectReadRoot = (target: unknown) => {
    if (typeof target === "string") return projectRoot(target);
    const { cwd } = z.object({
      cwd: z.string().max(4096).refine((value) => path.isAbsolute(value) && !value.includes("\0")),
    }).strict().parse(target);
    const usedLocally = (item: { cwd?: string; environment?: EnvironmentRef }) =>
      item.cwd === cwd && (item.environment?.kind ?? "local") === "local";
    if (
      !context.selectedFolders.has(cwd) &&
      !context.store.localFolderGrants?.includes(cwd) &&
      !context.store.projects.some(usedLocally) &&
      !context.store.conversations.some((session) => !session.cloudHosted && !session.cloudEnvironmentId &&
        (!session.sessionAuthors || (session.sessionAuthors.ownerAccountUuid === context.activeAccount?.id &&
          session.sessionAuthors.viewerAccountUuid === context.activeAccount?.id)) &&
        usedLocally(session))
    )
      throw Error("Choose the working folder with the folder picker.");
    return cwd;
  };
  handle("listProjectFolder", async (target: unknown, rawFolder: unknown) =>
    listProjectFolder(projectReadRoot(target), z.string().max(4096).parse(rawFolder)),
  );
  handle("readProjectFile", async (id: any, rawFile: unknown) =>
    readProjectFile(
      projectRoot(id),
      z.string().min(1).max(4096).parse(rawFile),
    ),
  );
  handle(
    "writeProjectFile",
    (
      id: unknown,
      rawFile: unknown,
      rawContent: unknown,
      rawRevision: unknown,
    ) => {
      const root = projectRoot(id, { write: true });
      context.allowedFolder(root, { kind: "local" });
      return writeProjectFile(
        root,
        z.string().min(1).max(4096).parse(rawFile),
        z.string().max(projectFileLimit).parse(rawContent),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(rawRevision),
      );
    },
  );
  handle("searchProjectFiles", async (target: unknown, rawQuery: unknown, rawOptions?: unknown) => {
    const query = z.string().max(1000).parse(rawQuery);
    const options = z.object({
        strict: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(projectSearchMaxResults).optional(),
        filesPane: z.literal(true).optional(),
        matchCase: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
        regexp: z.boolean().optional(),
      }).strict().optional().parse(rawOptions);
    if (target && typeof target === "object" && "environment" in target) {
      const { cwd: rawCwd, environment } = z.object({
        cwd: z.string(), environment: wslEnvironmentInput,
      }).strict().parse(target);
      const cwd = checkHostPath(rawCwd);
      if (cwd.includes("\\"))
        throw Error("This WSL path cannot be opened from Windows.");
      const store = context.store, identity = context.accountActivationIdentity;
      context.allowedFolder(cwd, environment);
      await requireWslWorkspaceTrust(context.engines, cwd, environment);
      const current = () => {
        if (context.store !== store || context.accountActivationIdentity !== identity)
          throw Error("The account changed during this request.");
      };
      current();
      const result = await searchProjectFiles(wslFolderUnc(environment.distro, cwd), query, options);
      current();
      return result;
    }
    return searchProjectFiles(projectReadRoot(target), query, options);
  });
  // Open in ▸ the editors this computer has (desktop 2.37337.1).
  handle("installedEditors", () => installedEditors());
  // Only a Code session's own folder opens, here or on its SSH host.
  handle(
    "openConversationInEditor",
    async (id: unknown, kind: unknown, rawFile: unknown, native?: unknown) => {
      const store = context.store;
      const c = store.conversation(string.parse(id));
      const editor = z.enum(editorKinds).parse(kind);
      if (native !== undefined) {
        const request = nativeEditorRequest.parse(native);
        const owner = context.activeAccount?.id;
        const identity = context.accountActivationIdentity;
        const { cwd, createdAt, environment } = c;
        const remote = environment?.kind === "ssh" ? environment : undefined;
        const paths = remote ? path.posix : path;
        if (!owner || !cwd || !paths.isAbsolute(cwd) || !paths.isAbsolute(request.target) ||
            request.ssh?.hostId !== remote?.hostId) return false;
        if (request.ssh) {
          const host = context.services?.ssh?.hosts.get(request.ssh.hostId);
          if (!host || host.destination !== request.ssh.sshHost ||
              (host.port ?? 22) !== (request.ssh.sshPort ?? 22) ||
              (host.identityFile ?? "") !== (request.ssh.sshIdentityFile ?? "")) return false;
        }
        const ssh = remote && sshEditorWorkspace(context, { id: c.id, cwd }, remote);
        if (remote && (!ssh || editor === "zed" || editor === "xcode")) return false;
        const folders = () => sessionRoots({
          cwd, additionalFolders: c.additionalFolders,
          worktree: c.worktree, additionalWorktrees: c.additionalWorktrees,
        });
        const roots = folders();
        const grants = [...(c.codeSessionFolderGrants ?? [])];
        const current = () => request.current() &&
          context.store === store && context.activeAccount?.id === owner &&
          context.accountActivationIdentity === identity && store.conversations.includes(c) &&
          c.createdAt === createdAt && c.cwd === cwd && c.mode === "code" &&
          (c.environment?.kind ?? "local") === (remote ? "ssh" : "local") &&
          (c.environment?.kind !== "ssh" || c.environment.hostId === request.ssh?.hostId) &&
          !c.cloudHosted && !c.cloudEnvironmentId && c.worktree?.state !== "deleted" &&
          (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === owner &&
            c.sessionAuthors.viewerAccountUuid === owner) &&
          isDeepStrictEqual(folders(), roots) &&
          isDeepStrictEqual(c.codeSessionFolderGrants ?? [], grants) &&
          (!ssh || ssh.current());
        if (!current()) return false;
        context.allowedFolder(cwd, c.environment);
        if (paths.normalize(request.target) === paths.normalize(cwd)) {
          if (request.line !== undefined) return false;
          if (ssh ? await ssh.verifyTrust() !== paths.normalize(cwd) : !(await fs.promises.stat(cwd)).isDirectory())
            return false;
          return openInEditor(editor, cwd, ssh?.target, current);
        }
        if (editor === "xcode") return false;
        const { file, root } = checkedFilePath(cwd, request.target, roots, paths);
        const authorize = () => {
          if (!current()) return false;
          if (!(grants.includes(root) && c.additionalFolders?.includes(root)) || root === cwd)
            context.allowedFolder(root, c.environment);
          return true;
        };
        if (!authorize()) return false;
        const identify = ssh?.identify ?? identifyLocalFile;
        const expected = await identify(root, file);
        if (ssh && expected.real !== file) return false;
        return openFileInEditor(editor, file, request.line, undefined, {
          ssh: ssh?.target,
          current: authorize,
          verify: async () => authorize() && isDeepStrictEqual(expected, await identify(root, file)),
        });
      }
      // A file of the folder (the Changes panel's file menu), never outside it.
      const file = z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .parse(rawFile ?? undefined);
      if (c.mode !== "code" || !c.cwd)
        throw Error("This conversation has no working folder.");
      let ssh: { destination: string; port?: number } | undefined;
      if (c.environment?.kind === "ssh") {
        const host =
          context.dataRoot &&
          new SshHostStore(context.dataRoot).get(c.environment.hostId);
        if (!host)
          throw Error("This session's SSH host isn't set up any more.");
        ssh = { destination: host.destination, port: host.port };
      } else if (!fs.statSync(c.cwd).isDirectory())
        throw Error("This conversation has no working folder.");
      if (file) {
        if (ssh || editor === "xcode") return false;
        const target = path.resolve(c.cwd, file);
        const inside = path.relative(c.cwd, target);
        if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
          throw Error("This file isn't in the session's folder.");
        if (!fs.existsSync(target)) return false;
        return openInEditor(editor, target);
      }
      return openInEditor(editor, c.cwd, ssh);
    },
  );
  // The title says what the folder is for (live claude.ai bundle,
  // 2026-10-12: "Choose a folder for the project").
  const dialogTitle = (raw: unknown) =>
    typeof raw === "string" && raw.trim()
      ? { title: raw.trim().slice(0, 200), message: raw.trim().slice(0, 200) }
      : {};
  handle("officialWslTrust", async (raw: unknown, rawCwd: unknown, save?: boolean) => {
    const environment = wslEnvironmentInput.parse(raw);
    const cwd = checkHostPath(rawCwd);
    const store = context.store;
    context.allowedFolder(cwd, environment);
    const distros = await listWslDistros();
    if (store !== context.store)
      throw Error("The account changed during the WSL workspace check.");
    if (!distros.some(({ name, version }) => version === 2 && name.toLowerCase() === environment.distro.toLowerCase()))
      throw Error("Choose an installed WSL 2 distribution.");
    if (!context.engines) throw Error("WSL Code is unavailable on this host.");
    const engine = context.engines.forEnvironment(environment);
    return save ? engine.trustRemoteWorkspace(cwd) : engine.remoteWorkspaceTrust(cwd);
  });
  handle("chooseFolder", async (title?: unknown, rawWslDistro?: unknown) => {
    const store = context.store;
    const target = rawWslDistro === undefined
      ? undefined
      : wslEnvironmentInput.parse({ kind: "wsl", distro: rawWslDistro });
    if (target && process.platform !== "win32")
      throw Error("WSL is unavailable on this host.");
    const result = await dialog.showOpenDialog(context.window!, {
      ...dialogTitle(title),
      properties: ["openDirectory", "createDirectory"],
      ...(target ? { defaultPath: `\\\\wsl.localhost\\${target.distro}\\` } : {}),
    });
    if (context.store !== store) throw Error("The account changed while choosing a folder.");
    const folder = result.canceled ? undefined : result.filePaths[0];
    if (folder) {
      const wsl = process.platform === "win32" ? wslFolderPath(folder) : undefined;
      if (wsl) {
        if (!context.remoteFolders) throw Error("WSL folder selection is unavailable.");
        const key = `wsl:${wsl.distro.toLowerCase()}`;
        const selected = context.remoteFolders.get(key) ?? new Set<string>();
        selected.add(wsl.cwd);
        context.remoteFolders.set(key, selected);
      } else {
        store.grantLocalFolders([folder]);
        context.selectedFolders.add(folder);
      }
    }
    return folder ?? null;
  });
  // A project's Add a folder takes several at once (live: "Select folders").
  handle("chooseFolders", async (title?: unknown) => {
    const store = context.store;
    const result = await dialog.showOpenDialog(context.window!, {
      ...dialogTitle(title),
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    if (context.store !== store) throw Error("The account changed while choosing a folder.");
    if (result.canceled) return [];
    const folders = [...new Set(result.filePaths)].filter(Boolean);
    if (folders.length) store.grantLocalFolders(folders);
    for (const folder of folders) context.selectedFolders.add(folder);
    return folders;
  });
  handle("chooseAttachments", async () => {
    // The operator's policy narrows the types and sizes (docs/admin-backend.md).
    const policy = context.policy();
    if (!policy.attachments.types.length)
      throw new Error("Your administrator has turned off attachments.");
    const result = await dialog.showOpenDialog(context.window!, {
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: policy.attachments.types.some((type) =>
            imageAttachmentTypes.includes(type),
          )
            ? "Images, documents and text"
            : "Documents and text",
          extensions: policy.attachments.types,
        },
      ],
    });
    const files: Attachment[] = [];
    for (const file of result.filePaths.slice(0, 12)) {
      const size = fs.statSync(file).size;
      const refusal = attachmentRefusal(path.basename(file), size, policy);
      if (refusal) throw new Error(refusal);
      const kind = attachmentKind(path.extname(file).slice(1));
      const a: Attachment = {
        id: randomUUID(),
        name: path.basename(file),
        path: file,
        size,
        kind,
        // The tile says how many lines a text file has (R-0243).
        ...(kind === "text"
          ? { lines: countLines(fs.readFileSync(file)) }
          : {}),
      };
      context.selectedAttachments.set(a.id, a);
      files.push(a);
    }
    return files;
  });
  handle("exportConversation", async (id: any) => {
    const c = context.store.conversation(string.parse(id));
    if (c.incognito) throw Error("Incognito conversations cannot be exported.");
    if (c.mode === "code") {
      const file = exportSessionArchive(c, app.getPath("downloads"));
      exportedSessions.add(file);
      return file;
    }
    const result = await dialog.showSaveDialog(context.window!, {
      defaultPath: c.title.replace(/[\\/:*?"<>|]/g, "_") + ".md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!result.filePath) return null;
    const text = conversationMarkdown(c);
    fs.writeFileSync(result.filePath, text);
    return result.filePath;
  });
}
