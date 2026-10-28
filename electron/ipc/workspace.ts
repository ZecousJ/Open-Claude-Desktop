import { app, dialog, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { projectToolsInput } from "../../shared/project-tools-input";
import { ownedProjectCapabilities } from "../../shared/project-access";
import { prepareProjectContext } from "../projects/project-create-context";
import type { Attachment, EnvironmentRef, Project } from "../../shared/types";
import type { Store } from "../store/store";
import { isPackageFolder } from "../workspace/package-folder";
import {
  listProjectFolder,
  readProjectFile,
  searchProjectFiles,
  writeProjectFile,
  projectFileLimit,
} from "../projects/project-files";
import { installedEditors, openInEditor } from "../workspace/editors";
import { SshHostStore } from "../ssh/host-store";
import { editorKinds } from "../../shared/editors";
import { conversationMarkdown } from "../conversations/data-export";
import { exportSessionArchive } from "../conversations/session-export";
import { environmentInput } from "../workspace/workspace-fs";
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
  readonly window: BrowserWindow | undefined;
  selectedFolders: Set<string>;
  selectedAttachments: Map<string, Attachment>;
  /** A folder counts only in its own environment (R9). */
  allowedFolder: (folder?: string, environment?: EnvironmentRef) => void;
  policy(): ClientPolicy;
  /** Where the SSH hosts are kept (Open in ▸ an editor over SSH). */
  readonly dataRoot?: string;
}
const string = z.string().min(1).max(500);
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
      // A new Cowork project starts pinned, however it was made.
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
    const i = context.store.projects.findIndex((v) => v.id === p.id);
    // Project visibility has no renderer mutation API. New account-owned
    // projects are private; edits preserve even unknown imported metadata.
    const previous = i < 0 ? undefined : context.store.projects[i];
    p.visibility =
      previous && Object.hasOwn(previous, "visibility")
        ? previous.visibility
        : "private";
    const before = i < 0 ? [] : projectFolders(context.store.projects[i]);
    const projectsBefore = context.store.projects;
    const prepared = initialContext
      ? prepareProjectContext(context.store.root, p, initialContext)
      : undefined;
    try {
      prepared?.commit();
      context.store.projects =
        i < 0
          ? [...projectsBefore, p]
          : projectsBefore.map((value, index) => (index === i ? p : value));
      context.store.flush();
    } catch (error) {
      context.store.projects = projectsBefore;
      prepared?.rollback();
      throw error;
    }
    // A folder that left the project no longer goes to its new Cowork tasks.
    const kept = projectFolders(p);
    const gone = before.filter((folder) => !kept.includes(folder));
    if (gone.length) releaseProjectFolders(p.id, gone);
    return p;
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
  handle("deleteProject", (id: any) => {
    string.parse(id);
    context.store.projects = context.store.projects.filter((p) => p.id !== id);
    for (const c of context.store.conversations)
      if (c.projectId === id) c.projectId = undefined;
    context.store.flush();
    releaseProjectFolders(id);
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
    return c.cwd;
  };
  handle("listProjectFolder", async (id: any, rawFolder: unknown) =>
    listProjectFolder(projectRoot(id), z.string().max(4096).parse(rawFolder)),
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
  handle("searchProjectFiles", async (id: any, rawQuery: unknown) =>
    searchProjectFiles(projectRoot(id), z.string().max(1000).parse(rawQuery)),
  );
  // Open in ▸ the editors this computer has.
  handle("installedEditors", () => installedEditors());
  // Only a Code session's own folder opens, here or on its SSH host.
  handle(
    "openConversationInEditor",
    async (id: any, kind: any, rawFile: unknown) => {
      const c = context.store.conversation(string.parse(id));
      const editor = z.enum(editorKinds as [string, ...string[]]).parse(kind);
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
        return openInEditor(editor as never, target);
      }
      return openInEditor(editor as never, c.cwd, ssh);
    },
  );
  // The title says what the folder is for.
  const dialogTitle = (raw: unknown) =>
    typeof raw === "string" && raw.trim()
      ? { title: raw.trim().slice(0, 200), message: raw.trim().slice(0, 200) }
      : {};
  handle("chooseFolder", async (title?: unknown) => {
    const result = await dialog.showOpenDialog(context.window!, {
      ...dialogTitle(title),
      properties: ["openDirectory", "createDirectory"],
    });
    const folder = result.filePaths[0];
    if (folder) context.selectedFolders.add(folder);
    return folder ?? null;
  });
  // A project's Add a folder takes several at once (live: "Select folders").
  handle("chooseFolders", async (title?: unknown) => {
    const result = await dialog.showOpenDialog(context.window!, {
      ...dialogTitle(title),
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    if (result.canceled) return [];
    const folders = [...new Set(result.filePaths)].filter(Boolean);
    for (const folder of folders) context.selectedFolders.add(folder);
    return folders;
  });
  handle("chooseAttachments", async () => {
    // The operator's policy narrows the types and sizes (docs/self-hosting.md).
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
        // The tile says how many lines a text file has.
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
