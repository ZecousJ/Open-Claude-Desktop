import { registerScheduledTaskSetup } from "../routines/scheduled-task-setup";
import { registerRoutineMigrationHandlers } from "../routines/routine-migration-handlers";
import {
  ProjectKnowledgeMcp,
  knowledgeMcpResourceInput,
} from "../projects/project-knowledge-mcp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Settings } from "../../shared/types";
import {
  knowledgeFileLimitMessage,
  type CustomizeSkill,
  type SkillContents,
  type SkillFile,
} from "../../shared/collections-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { assertSkillPathPrivate } from "../skills/skill-private";
import {
  CompletionUnavailableError,
  gatewayCompleter,
} from "../memory/completion";
import {
  DesignSystemStore,
  designSystemPrompt,
} from "../artifacts/design-systems";
import { PluginService, type PluginRpc } from "../plugins/plugins";
import { OrganizationPlugins } from "../plugins/organization-plugins";
import { OrganizationPluginPackages } from "../plugins/organization-plugin-package";
import type { Engine } from "../engine/engine";
import { Sub2ApiError } from "../sub2api/http";
import { organizationRuntimeCandidates } from "../../shared/official-organization-catalog";
import {
  CustomizeSearchService,
  customizeSkillSearchHits,
  customizePluginSearchHits,
  customizeConnectorSearchHits,
  customizeDirectorySearchHits,
  customizeSearchQuery,
} from "../plugins/customize-search";
import { MarketplaceState } from "../plugins/marketplace-state";
import { preference } from "../../shared/settings-extras";
import { DirectorySubmissions } from "../connectors/directory-submissions";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import {
  ProjectKnowledgeDrive,
  knowledgeDriveFileInput,
} from "../projects/project-knowledge-drive";
import {
  knowledgeRepositories,
  knowledgeRepositoryFiles,
  readKnowledgeRepositoryFiles,
  syncKnowledgeRepositoryFile,
} from "../projects/project-knowledge-github";
import {
  scheduleProposalFrom,
  scheduleProposalPrompt,
} from "../engine/schedule-proposal";
import {
  knowledgeExtensions,
  knowledgeFileLimit,
  ProjectKnowledgeStore,
  knowledgeTextName,
} from "../projects/project-knowledge";
import { PluginUploads } from "../plugins/plugin-upload";
import { pluginUploadInput } from "../../shared/plugin-upload-input";
import { ProjectKnowledgeUploads } from "../projects/project-knowledge-uploads";
import { ownedProjectCapabilities } from "../../shared/project-access";
import { registerDirectoryHandlers } from "./collections-directory";
import { registerScheduleHandlers } from "./collections-schedules";

export const id = z.string().min(1).max(500);
const knowledgeFileName = z.string().min(1).max(4096);

/** Largest SKILL.md shown in a skill's details. */
const skillMarkdownLimit = 512 * 1024;
const skillFileListLimit = 200;

/**
 * A skill's SKILL.md without its front matter and the files in its folder
 * (at most 200, four folders deep; links are not followed).
 */
export function readSkillContents(skillPath: string): SkillContents {
  const stat = fs.lstatSync(skillPath);
  if (!stat.isFile()) throw new Error("This skill's SKILL.md is missing.");
  // Read a bounded snapshot, rather than loading an arbitrarily large file
  // before truncating it. A replaced/symlinked SKILL.md is not a valid snapshot.
  const fd = fs.openSync(
    skillPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let text: string;
  let markdownTruncated = false;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error("This skill changed while it was being read.");
    markdownTruncated = opened.size > skillMarkdownLimit;
    const buffer = Buffer.alloc(Math.min(opened.size, skillMarkdownLimit));
    let offset = 0;
    while (offset < buffer.length) {
      const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      offset !== buffer.length
    )
      throw new Error("This skill changed while it was being read.");
    text = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const markdown = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const folder = path.dirname(skillPath);
  const files: SkillContents["files"] = [];
  let truncated = markdownTruncated;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
        else truncated = true;
      } else if (entry.isFile()) {
        if (files.length >= skillFileListLimit) {
          truncated = true;
          return;
        }
        files.push({
          path: path.relative(folder, full).split(path.sep).join("/"),
          bytes: fs.statSync(full).size,
        });
      }
    }
  };
  walk(folder, 0);
  return { markdown, files, truncated };
}

const skillFileLimit = 256 * 1024;

/**
 * A file inside a skill's folder, by its path relative to the folder. The
 * path must stay inside the folder once links are resolved.
 */
export function readSkillFileContents(
  skillPath: string,
  relative: string,
): SkillFile {
  const folder = fs.realpathSync(path.dirname(skillPath));
  const requested = path.resolve(folder, relative);
  const target = fs.realpathSync(requested);
  if (!target.startsWith(folder + path.sep))
    throw new Error("That file is outside the skill's folder.");
  const initial = fs.lstatSync(target);
  if (!initial.isFile()) throw new Error("That is not a file.");
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    const same = (value: fs.Stats) =>
      value.isFile() &&
      value.dev === opened.dev &&
      value.ino === opened.ino &&
      value.size === opened.size &&
      value.mtimeMs === opened.mtimeMs &&
      value.ctimeMs === opened.ctimeMs;
    if (!same(initial))
      throw new Error("This skill file changed while it was being read.");
    const bytes = Buffer.alloc(Math.min(opened.size, skillFileLimit));
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    if (
      offset !== bytes.length ||
      !same(fs.fstatSync(fd)) ||
      fs.realpathSync(path.dirname(skillPath)) !== folder ||
      fs.realpathSync(requested) !== target ||
      !same(fs.lstatSync(target))
    )
      throw new Error("This skill file changed while it was being read.");
    const binary = bytes.includes(0);
    return {
      text: binary ? "" : bytes.toString("utf8"),
      truncated: !binary && opened.size > skillFileLimit,
      binary,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** The connection and model a routine on "Default" runs with. */
export function defaultModelChoice(settings: Settings) {
  const provider =
    settings.providers.find((p) => p.id === settings.activeProviderId) ??
    settings.providers[0];
  return provider?.model
    ? { providerId: provider.id, model: provider.model }
    : undefined;
}

const scopes = new Set<CustomizeSkill["scope"]>([
  "user",
  "repo",
  "system",
  "admin",
]);

/**
 * The runtime's skills for Customize, once each, with when their SKILL.md
 * changed. Only paths the runtime reported are read; `own` marks the
 * person's skills under the profile, the only ones that can be removed.
 */
export async function customizeSkills(
  ctx: Pick<AppContext, "engine" | "store">,
): Promise<CustomizeSkill[]> {
  const rpc = ctx.engine.rpc;
  const store = ctx.store;
  if (!rpc) return [];
  const groups: { skills?: any[] }[] =
    (await rpc.call("skills/list", { forceReload: true })).data ?? [];
  if (ctx.store !== store || ctx.engine.rpc !== rpc)
    throw new Error("The signed-in account changed. Try again.");
  const userSkills = path.join(store.root, "codex-home", "skills");
  const seen = new Set<string>();
  const skills: CustomizeSkill[] = [];
  for (const skill of groups.flatMap((group) => group.skills ?? [])) {
    if (typeof skill?.path !== "string" || seen.has(skill.path)) continue;
    seen.add(skill.path);
    let editedAt: number | undefined;
    try {
      editedAt = Math.round(fs.statSync(skill.path).mtimeMs);
    } catch {
      editedAt = undefined;
    }
    const own = path.dirname(path.dirname(skill.path)) === userSkills;
    const provenance = own
      ? { source: "you" as const }
      : skill.scope === "admin"
        ? { source: "organization" as const }
        : skill.scope === "repo"
          ? { source: "project" as const }
          : undefined;
    skills.push({
      name: String(skill.name ?? path.basename(path.dirname(skill.path))),
      description: String(skill.description ?? ""),
      path: skill.path,
      scope: scopes.has(skill.scope) ? skill.scope : "system",
      enabled: skill.enabled !== false,
      ...(editedAt === undefined ? {} : { editedAt }),
      own,
      ...(provenance ? { provenance } : {}),
    });
  }
  return skills;
}

/**
 * Collection pages (package WP7): Customize's skill list and routines. The
 * scheduler enforces the administrator's `scheduledTasks` policy; the
 * folder must be one the person chose, and "Default" resolves to the
 * active connection's model. R13-D adds a routine's run history, custom
 * sidebar groups, project knowledge files and a skill's contents.
 */
export function registerCollectionHandlers(handle: IpcHandle, ctx: AppContext) {
  registerRoutineMigrationHandlers(handle, ctx, defaultModelChoice);
  const setup = registerScheduledTaskSetup(ctx);
  handle("customizeSkills", () => customizeSkills(ctx));
  registerScheduleHandlers({ ctx, handle, setup });

  // Project knowledge files (R13-D).
  const knowledge = () => {
    const store = ctx.store,
      owner = knowledgeOwner();
    return new ProjectKnowledgeStore(store.root, () => {
      if (owner !== knowledgeOwner())
        throw new Error("The signed-in account changed. Try again.");
      return store.projects;
    });
  };
  let uploadOwner: { store: typeof ctx.store } | undefined;
  let uploadService:
    { owner: object; value: ProjectKnowledgeUploads } | undefined;
  const knowledgeOwner = () => {
    if (!uploadOwner || uploadOwner.store !== ctx.store)
      uploadOwner = { store: ctx.store };
    return uploadOwner;
  };
  const knowledgeUploads = () => {
    const owner = knowledgeOwner();
    if (!uploadService || uploadService.owner !== owner) {
      const store = ctx.store;
      uploadService = {
        owner,
        value: new ProjectKnowledgeUploads(
          new ProjectKnowledgeStore(store.root, () => {
            if (owner !== knowledgeOwner())
              throw new Error("The signed-in account changed. Try again.");
            return store.projects;
          }),
          {
            owner: knowledgeOwner,
            canEdit: (projectId) => {
              const project = ctx.store.projects.find(
                (value) => value.id === projectId,
              );
              return Boolean(
                project &&
                ownedProjectCapabilities(project).canEditKnowledgeBase,
              );
            },
          },
        ),
      };
    }
    return uploadService.value;
  };
  ctx.onAccountDeactivating(() => {
    uploadOwner = undefined;
    uploadService = undefined;
  });
  const mutateKnowledge = (projectId: string, run: () => unknown) => {
    const owner = knowledgeOwner(),
      service = knowledgeUploads();
    knowledge().assertCanEdit(projectId);
    const finish = () => {
      if (owner !== knowledgeOwner())
        throw new Error("The signed-in account changed. Try again.");
      return service.list(projectId);
    };
    const result = run();
    return result && typeof (result as Promise<unknown>).then === "function"
      ? Promise.resolve(result).then(finish)
      : finish();
  };
  const drive = new ProjectKnowledgeDrive(ctx);
  const mcpResources = new ProjectKnowledgeMcp(ctx);
  handle("listProjectKnowledge", (project: unknown) => {
    const store = knowledge();
    store.prune();
    return knowledgeUploads().list(id.parse(project));
  });
  handle("stageProjectKnowledgeFiles", (project: unknown, raw: unknown) => {
    const files = z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          data: z
            .instanceof(Uint8Array)
            .refine((value) => value.byteLength <= knowledgeFileLimit),
        }),
      )
      .max(200)
      .refine(
        (files) =>
          files.reduce((sum, file) => sum + file.data.byteLength, 0) <=
          100_000_000,
      )
      .parse(raw);
    return knowledgeUploads().stageFiles(id.parse(project), files);
  });
  handle(
    "previewProjectKnowledgeEncoding",
    (project: unknown, pending: unknown, encoding: unknown) =>
      knowledgeUploads().previewEncoding(
        id.parse(project),
        id.parse(pending),
        z.string().min(1).max(100).parse(encoding),
      ),
  );
  handle(
    "confirmProjectKnowledgeEncoding",
    (project: unknown, pending: unknown, encoding: unknown) =>
      knowledgeUploads().confirmEncoding(
        id.parse(project),
        id.parse(pending),
        z.string().min(1).max(100).parse(encoding),
      ),
  );
  handle(
    "removeProjectKnowledgePending",
    (project: unknown, pending: unknown) =>
      knowledgeUploads().removePending(id.parse(project), id.parse(pending)),
  );
  handle("readProjectKnowledge", (project: unknown, name: unknown) =>
    knowledge().read(id.parse(project), knowledgeFileName.parse(name)),
  );
  handle("confirmProjectKnowledgeUpload", (project: unknown, input: unknown) =>
    knowledge().confirmUpload(id.parse(project), z.object({
      name: knowledgeFileName,
      bytes: z.number().int().nonnegative().max(knowledgeFileLimit),
      addedAt: z.number().nonnegative().max(8.64e15),
    }).parse(input)),
  );
  handle("addProjectKnowledge", async (project: unknown) => {
    const store = knowledge();
    const projectId = id.parse(project);
    store.assertCanEdit(projectId);
    // Loaded here: this module is also imported by tests outside Electron.
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog(ctx.window!, {
      title: "Add files to the project",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Text files and PDFs", extensions: knowledgeExtensions },
      ],
    });
    // The bound store checks the original account after the native picker.
    store.assertCanEdit(projectId);
    if (result.canceled || !result.filePaths.length)
      return knowledgeUploads().list(projectId);
    const files: { name: string; data: Buffer }[] = [];
    for (const file of result.filePaths) {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile())
        throw new Error(`${path.basename(file)} isn't a file.`);
      if (stat.size > knowledgeFileLimit)
        throw new Error(
          `${path.basename(file)} is too large. ${knowledgeFileLimitMessage}`,
        );
      files.push({ name: path.basename(file), data: await fs.promises.readFile(file) });
    }
    store.prune();
    return mutateKnowledge(projectId, () => store.add(projectId, files));
  });
  // The web's picker: the page read the files, the bytes come with the call.
  handle("addProjectKnowledgeFiles", (project: unknown, raw: unknown) => {
    const files = z
      .array(
        z.object({
          name: knowledgeFileName,
          data: z
            .instanceof(Uint8Array)
            .refine(
              (data) => data.byteLength <= knowledgeFileLimit,
              knowledgeFileLimitMessage,
            ),
        }),
      )
      .min(1)
      .max(12)
      .parse(raw);
    const store = knowledge();
    store.prune();
    const projectId = id.parse(project);
    return mutateKnowledge(projectId, () =>
      store.add(
        projectId,
        files.map((file) => ({
          name: file.name,
          data: Buffer.from(
            file.data.buffer,
            file.data.byteOffset,
            file.data.byteLength,
          ),
        })),
      ),
    );
  });
  handle("addProjectKnowledgeText", (project: unknown, raw: unknown) => {
    const file = z
      .object({
        name: z.string().max(200),
        text: z.string().min(1).max(knowledgeFileLimit),
        displayName: z.string().min(1).max(200).optional(),
      })
      .parse(raw);
    const name = knowledgeTextName(file.name);
    const projectId = id.parse(project);
    return mutateKnowledge(projectId, () =>
      knowledge().add(projectId, [
        { name, data: Buffer.from(file.text, "utf8"), displayName: file.displayName },
      ]),
    );
  });
  handle("listProjectKnowledgeRepositories", (project: unknown) => {
    knowledge().folder(id.parse(project));
    return knowledgeRepositories();
  });
  handle(
    "listProjectKnowledgeRepositoryFiles",
    (project: unknown, repository: unknown, branch: unknown) => {
      knowledge().folder(id.parse(project));
      return knowledgeRepositoryFiles(id.parse(repository), id.parse(branch));
    },
  );
  handle(
    "addProjectKnowledgeRepositoryFiles",
    async (
      project: unknown,
      repository: unknown,
      raw: unknown,
      branch: unknown = "HEAD",
    ) => {
      const projectId = id.parse(project);
      const store = knowledge();
      store.folder(projectId);
      const ref = z.string().min(1).max(200).parse(branch);
      const files = z
        .array(
          z.object({
            name: knowledgeFileName,
            sha: z.string().regex(/^[a-f0-9]{40,64}$/),
            bytes: z.number().min(0).max(knowledgeFileLimit),
          }),
        )
        .min(1)
        .max(200)
        .parse(raw);
      const repo = id.parse(repository);
      const loaded = await readKnowledgeRepositoryFiles(repo, files);
      return mutateKnowledge(projectId, () =>
        store.add(projectId, loaded.map((file, index) => ({
          ...file,
          source: {
            provider: "github",
            repository: repo,
            branch: ref,
            path: files[index].name,
            status: "idle",
            lastSyncedAt: Date.now(),
          },
        }))),
      );
    },
  );
  handle("syncProjectKnowledge", (project: unknown, name: unknown) => {
    const store = knowledge();
    const projectId = id.parse(project);
    const fileName = knowledgeFileName.parse(name);
    const source = store
      .list(projectId)
      .files.find((file) => file.name === fileName)?.source;
    return mutateKnowledge(projectId, () =>
      source?.provider === "gdrive"
        ? drive.sync(store, projectId, fileName)
        : source?.provider === "mcp"
          ? mcpResources.sync(store, projectId, fileName)
          : syncKnowledgeRepositoryFile(store, projectId, fileName),
    );
  });
  handle("listProjectKnowledgeMcpServers", (project: unknown) => {
    knowledge().folder(id.parse(project));
    return mcpResources.servers();
  });
  handle(
    "listProjectKnowledgeMcpResources",
    (project: unknown, server: unknown, query: unknown = "") => {
      knowledge().folder(id.parse(project));
      return mcpResources.resources(
        id.parse(server),
        z.string().max(1000).parse(query),
      );
    },
  );
  handle(
    "resolveProjectKnowledgeMcpUrl",
    (project: unknown, server: unknown, url: unknown) => {
      knowledge().folder(id.parse(project));
      return mcpResources.resolve(
        id.parse(server),
        z.string().url().max(4096).parse(url),
      );
    },
  );
  handle(
    "addProjectKnowledgeMcpResource",
    (project: unknown, server: unknown, resource: unknown) => {
      const projectId = id.parse(project);
      return mutateKnowledge(projectId, () =>
        mcpResources.add(
          knowledge(),
          projectId,
          id.parse(server),
          knowledgeMcpResourceInput.parse(resource),
        ),
      );
    },
  );
  handle("listProjectKnowledgeDriveConnectors", (project: unknown) => {
    knowledge().folder(id.parse(project));
    return drive.connectors();
  });
  handle(
    "searchProjectKnowledgeDrive",
    (project: unknown, server: unknown, query: unknown) => {
      knowledge().folder(id.parse(project));
      return drive.search(
        id.parse(server),
        z.string().trim().min(1).max(1000).parse(query),
      );
    },
  );
  handle(
    "addProjectKnowledgeDriveFiles",
    (project: unknown, server: unknown, files: unknown) => {
      const projectId = id.parse(project);
      return mutateKnowledge(projectId, () =>
        drive.add(
          knowledge(),
          projectId,
          id.parse(server),
          z.array(knowledgeDriveFileInput).min(1).max(200).parse(files),
        ),
      );
    },
  );
  handle("removeProjectKnowledge", (project: unknown, name: unknown) => {
    const projectId = id.parse(project);
    return mutateKnowledge(projectId, () =>
      knowledge().remove(
        projectId,
        z
          .union([
            knowledgeFileName,
            z.array(knowledgeFileName).min(1).max(200),
          ])
          .parse(name),
      ),
    );
  });

  handle("readSkill", async (raw: unknown) => {
    const skillPath = id.parse(raw);
    // Only a SKILL.md the runtime lists, never a path from the page.
    const listed = (await customizeSkills(ctx)).some(
      (skill) => skill.path === skillPath,
    );
    if (!listed) throw new Error("This skill is no longer installed.");
    assertSkillPathPrivate(ctx, skillPath);
    return readSkillContents(skillPath);
  });
  handle("readSkillFile", async (raw: unknown, file: unknown) => {
    const skillPath = id.parse(raw);
    const listed = (await customizeSkills(ctx)).some(
      (skill) => skill.path === skillPath,
    );
    if (!listed) throw new Error("This skill is no longer installed.");
    assertSkillPathPrivate(ctx, skillPath);
    return readSkillFileContents(skillPath, id.parse(file));
  });
  // Design systems: one file per account; Claude writes the guidelines with
  // the account's model through this engine's gateway.
  const designs = () => new DesignSystemStore(ctx.store.root);
  const designModel = gatewayCompleter(async () => {
    const settings = ctx.store.settings;
    const provider = settings.providers.find(
      (item) => item.id === settings.activeProviderId,
    );
    if (!provider) return undefined;
    if (!ctx.engine.gatewayEndpoint()) {
      try {
        await ctx.engine.ensure(provider, { interactive: false });
      } catch {
        return undefined;
      }
    }
    const endpoint = ctx.engine.gatewayEndpoint();
    return endpoint ? { ...endpoint, model: provider.model } : undefined;
  });
  handle("proposeScheduledTask", async (raw: unknown) => {
    const description = z.string().min(1).max(4000).parse(raw).trim();
    let answer: string | undefined;
    try {
      answer = await designModel(scheduleProposalPrompt(description));
    } catch {
      // No model reachable: the words alone give the schedule.
    }
    return scheduleProposalFrom(description, answer);
  });
  handle("listDesignSystems", () => designs().list());
  handle("saveDesignSystem", (raw: unknown) =>
    designs().save(
      z
        .object({
          id: id.optional(),
          name: z.string().max(500),
          blurb: z.string().max(20_000).optional(),
          notes: z.string().max(20_000).optional(),
          sources: z
            .array(z.object({ name: z.string(), text: z.string() }))
            .max(100)
            .optional(),
          guidelines: z.string().max(200_000).optional(),
        })
        .parse(raw),
    ),
  );
  handle("deleteDesignSystem", (raw: unknown) =>
    designs().delete(id.parse(raw)),
  );
  handle("generateDesignSystem", async (raw: unknown) => {
    const store = designs();
    const system = store.get(id.parse(raw));
    if (!system) throw new Error("That design system is gone.");
    if (!system.blurb.trim() && !system.notes.trim() && !system.sources.length)
      throw new Error(
        "Describe the company or add an example file first, so there is something to build the design system from.",
      );
    try {
      return store.setGenerated(
        system.id,
        await designModel(designSystemPrompt(system)),
      );
    } catch (error) {
      if (error instanceof CompletionUnavailableError)
        throw new Error("No model is available to write the design system.");
      throw error;
    }
  });
  // Plugins: the agent runtime's own marketplaces and installs. Its skills,
  // servers and hooks apply to the account's next turns.
  // Desktop uses the person's home. The runner discovers the account's
  // private marketplace from its codex-home, never the shared host home.
  const personalHome = () =>
    ctx.window === undefined ? undefined : os.homedir();
  const pluginHome = () =>
    personalHome() ?? path.join(ctx.store.root, "codex-home");
  const plugins = new PluginService(
    async () => {
      if (!ctx.engine.rpc) {
        const settings = ctx.store.settings;
        const provider = settings.providers.find(
          (item) => item.id === settings.activeProviderId,
        );
        if (!provider)
          throw new Error("Choose a model connection so the agent can start.");
        await ctx.engine.ensure(provider, { interactive: false });
      }
      if (!ctx.engine.rpc) throw new Error("The agent isn't running.");
      return ctx.engine.rpc;
    },
    pluginHome,
    new MarketplaceState(() => ctx.store.root),
    () => preference(ctx.store.settings, "networkEgress"),
    // On this computer (or the runner) the agent's CODEX_HOME is local; an
    // SSH host's is not.
    () =>
      ctx.engine.environment?.kind === "ssh"
        ? undefined
        : (ctx.engine as { codexHome?: string }).codexHome,
  );
  const activePlugins = () => {
    const { store, engine, accountActivationIdentity } = ctx;
    const home = pluginHome();
    const current = () =>
      !ctx.accountRetiring &&
      ctx.store === store &&
      ctx.engine === engine &&
      ctx.accountActivationIdentity === accountActivationIdentity;
    assertAccountOperationCurrent(current);
    const acquire = async (): Promise<PluginRpc> => {
      assertAccountOperationCurrent(current);
      if (!engine.rpc) {
        const provider = store.settings.providers.find(
          item => item.id === store.settings.activeProviderId,
        );
        if (!provider)
          throw Error("Choose a model connection so the agent can start.");
        await engine.ensure(provider, { interactive: false, current });
      }
      assertAccountOperationCurrent(current);
      const rpc = engine.rpc;
      if (!rpc) throw Error("The agent isn't running.");
      const currentRuntime = () => current() && engine.rpc === rpc;
      return {
        call: async (method, params) => {
          assertAccountOperationCurrent(currentRuntime);
          const result = await rpc.call(method, params);
          assertAccountOperationCurrent(currentRuntime);
          return result;
        },
      };
    };
    let runtime: ReturnType<typeof acquire> | undefined;
    return new PluginService(
      () => (runtime ??= acquire()),
      () => home,
      new MarketplaceState(() => store.root),
      () => preference(store.settings, "networkEgress"),
    );
  };
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let syncing: Promise<void> | undefined;
  ctx.onAccountActivated(() => {
    if (syncTimer) clearInterval(syncTimer);
    const sync = () => {
      if (!syncing)
        syncing = plugins
          .syncAutomatically()
          .catch(() => undefined)
          .finally(() => {
            syncing = undefined;
          });
    };
    sync();
    // Auto-synced GitHub marketplaces are checked hourly, not on every tick.
    syncTimer = setInterval(sync, 60 * 60_000);
    syncTimer.unref();
  });
  ctx.onAccountDeactivating(async () => {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = undefined;
    await syncing;
  });
  handle("listPlugins", () => plugins.list());
  const organizationPlugins = new OrganizationPlugins();
  const organizationPluginId = z.string().regex(/^plugin_[a-f0-9]{24}$/);
  const organizationPluginActivation = (target = ctx.engine, turnCurrent?: () => boolean) => {
    const { remote, store, engine, accountActivationIdentity } = ctx;
    if (!remote?.ready || (!ctx.window && !ctx.organizationPluginsOnRunner) || engine.environment?.kind === "ssh") return undefined;
    const peer = target !== engine;
    const peerRpc = peer ? target.rpc : undefined;
    if (peer && (!ctx.organizationPluginsOnRunner || target.environment.kind !== "space" || !peerRpc)) return undefined;
    const current = () => !ctx.accountRetiring && ctx.remote === remote && ctx.store === store &&
      ctx.engine === engine && ctx.accountActivationIdentity === accountActivationIdentity &&
      turnCurrent?.() !== false && (!peer || target.rpc === peerRpc);
    assertAccountOperationCurrent(current);
    const rpc = peerRpc ? async (): Promise<PluginRpc> => ({
      async call(method, params) {
        assertAccountOperationCurrent(current);
        const result = await peerRpc.call(method, params);
        assertAccountOperationCurrent(current);
        return result;
      },
    }) : activePlugins().rpc;
    return {
      root: peer ? target.spaceRoot : store.root,
      packages: new OrganizationPluginPackages(remote.backend.client, remote.session, current),
      rpc,
      current,
      sandboxReadable: ctx.organizationPluginsOnRunner === true,
    };
  };
  let pendingOrganizationReconciliation: { identity: unknown; result: Promise<void> } | undefined;
  const reconcileOrganizationPlugins = (activation: NonNullable<ReturnType<typeof organizationPluginActivation>>) => {
    const identity = ctx.accountActivationIdentity;
    if (pendingOrganizationReconciliation?.identity === identity && pendingOrganizationReconciliation)
      return pendingOrganizationReconciliation.result;
    const result = organizationPlugins.reconcile(activation).finally(() => {
      if (pendingOrganizationReconciliation?.result === result) pendingOrganizationReconciliation = undefined;
    });
    pendingOrganizationReconciliation = { identity, result };
    return result;
  };
  ctx.onAccountActivated(() => {
    if (!ctx.organizationPluginsOnRunner) return;
    const primary = ctx.engine;
    primary.prepareOrganizationPlugins = async (target: Engine, turnCurrent) => {
      if (target.environment.kind !== "space") return false;
      const account = organizationPluginActivation(primary, turnCurrent);
      const conversation = organizationPluginActivation(target, turnCurrent);
      if (!account || !conversation) throw Error("The organization plugin runtime is unavailable.");
      try {
        return await organizationPlugins.syncForConversation(account, conversation);
      } catch (error) {
        if (error instanceof Sub2ApiError && error.status === 404 && error.code !== "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND" &&
          [account.root, conversation.root].every(root => {
            const directory = path.join(root, "organization-plugins");
            return !fs.existsSync(directory) || !fs.readdirSync(directory).some(name => /^plugin_[a-f0-9]{24}$/.test(name));
          })) return false;
        throw error;
      }
    };
  });
  handle("readOrganizationPluginStates", (candidates: unknown) => {
    const activation = organizationPluginActivation();
    if (!activation) return undefined;
    const rows = organizationRuntimeCandidates.parse(candidates);
    return reconcileOrganizationPlugins(activation).then(() => organizationPlugins.states(rows, activation));
  });
  handle("readOrganizationPluginDetails", (id: unknown) => {
    const activation = organizationPluginActivation();
    if (!activation) return undefined;
    return organizationPlugins.details(organizationPluginId.parse(id), activation);
  });
  handle("setOrganizationPluginEnabled", (id: unknown, enabled: unknown) => {
    const activation = organizationPluginActivation();
    if (!activation)
      throw Error("Organization plugin installation requires a local desktop runtime.");
    return organizationPlugins.setEnabled(organizationPluginId.parse(id), z.boolean().parse(enabled), activation);
  });
  handle("removeOrganizationPlugin", (id: unknown) => {
    const activation = organizationPluginActivation();
    if (!activation)
      throw Error("Organization plugin removal requires a local desktop runtime.");
    return organizationPlugins.remove(organizationPluginId.parse(id), activation);
  });
  const uploads = new PluginUploads(async () => {
    await plugins.list();
    return ctx.engine.rpc!;
  });
  ctx.onAccountDeactivating(() => uploads.close());
  handle("uploadPlugin", (raw: unknown) =>
    uploads.command(pluginUploadInput.parse(raw), ctx.store.root, pluginHome()),
  );
  const submissions = () => {
    const { remote, store, accountActivationIdentity } = ctx;
    if (!remote) throw Error("The directory service is unavailable.");
    const current = () => !ctx.accountRetiring && ctx.remote === remote &&
      ctx.store === store && ctx.accountActivationIdentity === accountActivationIdentity;
    assertAccountOperationCurrent(current);
    return new DirectorySubmissions((route, init) =>
      remote.session.authorized(async (token) => {
        assertAccountOperationCurrent(current);
        const result = await remote.backend.client.directoryRequest(token, route, init);
        assertAccountOperationCurrent(current);
        return result;
      }, current),
    );
  };
  // The cursor owns a snapshot of real account inventory. Retiring the
  // account or runtime invalidates continuations and late catalogue reads.
  let searchGeneration = 0;
  let searchOwner:
    | {
        store: typeof ctx.store;
        engine: typeof ctx.engine;
        rpc: typeof ctx.engine.rpc;
        remote: typeof ctx.remote;
      }
    | undefined;
  const owner = () => {
    if (
      !searchOwner ||
      searchOwner.store !== ctx.store ||
      searchOwner.engine !== ctx.engine ||
      searchOwner.rpc !== ctx.engine.rpc ||
      searchOwner.remote !== ctx.remote
    )
      searchOwner = {
        store: ctx.store,
        engine: ctx.engine,
        rpc: ctx.engine.rpc,
        remote: ctx.remote,
      };
    return searchOwner;
  };
  ctx.onAccountDeactivating(() => {
    searchGeneration++;
    searchOwner = undefined;
  });
  const search = new CustomizeSearchService({
    owner,
    async readHits() {
      const captured = owner();
      const assertCurrent = () => {
        if (captured !== owner())
          throw new Error("The signed-in account changed. Try again.");
      };
      // Establish the actual runtime before reading skills; this is the same
      // runtime reader used by Plugins, without sending a model message.
      const catalog = await plugins.list();
      assertCurrent();
      const [skills, directory] = await Promise.all([
        customizeSkills(ctx),
        ctx.remote ? submissions().directory() : Promise.resolve([]),
      ]);
      assertCurrent();
      const connectors = Object.keys(ctx.store.settings.mcpServers).map(
        (name) => ({
          id: name,
          name,
          // A saved configuration is present in Yours; authentication/health
          // remains the connector page's responsibility.
          connected: true,
        }),
      );
      return [
        ...customizeSkillSearchHits(skills),
        ...customizePluginSearchHits(catalog),
        ...customizeConnectorSearchHits(connectors),
        ...customizeDirectorySearchHits(directory),
      ];
    },
  });
  handle("customizeSearch", async (raw: unknown) => {
    const request =
      raw as import("../../shared/customize-search").CustomizeSearchRequest;
    // Starting a runtime establishes its lease before the cursor captures it.
    // Ineligible queries still take the service's cheap, provider-free path.
    if (
      !ctx.engine.rpc &&
      typeof request?.query === "string" &&
      customizeSearchQuery(request.query)
    ) {
      const store = ctx.store,
        engine = ctx.engine,
        remote = ctx.remote,
        generation = searchGeneration;
      await plugins.list();
      if (
        ctx.store !== store ||
        ctx.engine !== engine ||
        ctx.remote !== remote ||
        searchGeneration !== generation
      )
        throw new Error("The signed-in account changed. Try again.");
    }
    return search.search(request);
  });
  registerDirectoryHandlers({ ctx, handle, plugins, activePlugins, submissions });
}
