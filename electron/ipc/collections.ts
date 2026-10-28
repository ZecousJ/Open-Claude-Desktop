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
import type {
  CustomizeSkill,
  SkillContents,
  SkillFile,
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
import { PluginService } from "../plugins/plugins";
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
  const text = fs
    .readFileSync(skillPath)
    .subarray(0, skillMarkdownLimit)
    .toString("utf8");
  const markdown = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const folder = path.dirname(skillPath);
  const files: SkillContents["files"] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
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
  const target = fs.realpathSync(path.resolve(folder, relative));
  if (!target.startsWith(folder + path.sep))
    throw new Error("That file is outside the skill's folder.");
  if (!fs.statSync(target).isFile()) throw new Error("That is not a file.");
  const bytes = fs.readFileSync(target).subarray(0, skillFileLimit);
  const binary = bytes.includes(0);
  return {
    text: binary ? "" : bytes.toString("utf8"),
    truncated: !binary && fs.statSync(target).size > skillFileLimit,
    binary,
  };
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
 * Collection pages: Customize's skill list and routines. The scheduler enforces
 * the administrator's `scheduledTasks` policy; the folder must be one the
 * person chose, and "Default" resolves to the active connection's model. R13-D
 * adds a routine's run history, custom sidebar groups, project knowledge files
 * and a skill's contents.
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
          new ProjectKnowledgeStore(store.root, () => store.projects),
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
    const files = result.filePaths.map((file) => {
      const stat = fs.statSync(file);
      if (!stat.isFile())
        throw new Error(`${path.basename(file)} isn't a file.`);
      if (stat.size > knowledgeFileLimit)
        throw new Error(
          `${path.basename(file)} is too large. Project files can be up to 10 MB.`,
        );
      return { name: path.basename(file), data: fs.readFileSync(file) };
    });
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
              "Project files can be up to 10 MB.",
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
      })
      .parse(raw);
    const trimmed = file.name.trim();
    const name = /\.(md|txt)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
    const projectId = id.parse(project);
    return mutateKnowledge(projectId, () =>
      knowledge().add(projectId, [
        { name, data: Buffer.from(file.text, "utf8") },
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
      const loaded = await readKnowledgeRepositoryFiles(
        id.parse(repository),
        files,
      );
      store.add(projectId, loaded);
      store.setSources(
        projectId,
        Object.fromEntries(
          files.map((file) => [
            `${repository}/${file.name}`,
            {
              provider: "github" as const,
              repository: id.parse(repository),
              branch: ref,
              path: file.name,
              status: "idle" as const,
              lastSyncedAt: Date.now(),
            },
          ]),
        ),
      );
      return knowledgeUploads().list(projectId);
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
  const uploads = new PluginUploads(async () => {
    await plugins.list();
    return ctx.engine.rpc!;
  });
  ctx.onAccountDeactivating(() => uploads.close());
  handle("uploadPlugin", (raw: unknown) =>
    uploads.command(pluginUploadInput.parse(raw), ctx.store.root, pluginHome()),
  );
  const submissions = () => {
    const remote = ctx.remote;
    if (!remote) throw new Error("Failed to submit. You can try again.");
    return new DirectorySubmissions((route, init) =>
      remote.session.authorized((token) =>
        remote.backend.client.directoryRequest(token, route, init),
      ),
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
  registerDirectoryHandlers({ ctx, handle, plugins, submissions });
}
