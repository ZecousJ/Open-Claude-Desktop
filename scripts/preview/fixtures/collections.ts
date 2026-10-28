/**
 * Collection pages for the fixture bridge: routines on an in-memory scheduler,
 * the administrator's routine limits, a folder for the routine editor's picker,
 * and Customize's skills and MCP servers. Nothing runs; Run now only flips the
 * state.
 *
 * routines=some    six saved routines (running, paused, failed, manual …)
 * routinesPolicy=off|limit   routines turned off, or capped at 3
 * folder=1         the folder picker answers /Users/ada/Projects/claudex
 * skills=some      three of the person's skills besides two built-in ones
 * skill contents: synthetic local bundle/UTF-8 previews for those listed skills;
 *                 no official skill files or creator metadata are copied
 * mcp=none         no connectors (default: docs ready, browser failed)
 * approved directory: empty by default; connectorCuration=some adds three
 *                     clearly named test features, with no added host abilities
 * Linear status: explicitly not connected; no account or connection is created
 * projects=some    five projects, the first holding three chats
 * knowledge=some   the first project keeps eight context files (default: none)
 * designSystems=some  two design systems, one with guidelines and one a draft
 * plugins=some|error  a synced marketplace with plugins (default: none synced;
 *                     error: the runtime cannot list them)
 */
import type { ClientPolicy } from "../../../shared/client-policy";
import { frequencyFor, nextRun, routineLimitMessage, routinesOffMessage, type Routine, type RoutineInput, type RoutineRepeat, type RoutineRunQuery, validRepeat, routineNameProblem } from "../../../shared/routines";
import { type RoutineRun } from "../../../shared/routine-labels";
import { proposeSchedule } from "../../../shared/routine-proposals";
import { pageRoutineRuns } from "../../../shared/routine-history-page";
import { recordedRoutineRunCount } from "../../../shared/routine-run-count";
import type { DeviceTrustState } from "../../../shared/remote-devices";
import type { Project } from "../../../shared/types";
import type {
  CustomizeSkill,
  DesignSystem,
  DesignSystemInput,
  PluginCatalog,
  PluginEntry,
  KnowledgeFile,
  KnowledgePreview,
  ProjectKnowledge,
} from "../../../shared/collections-api";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import { fixturePolicy, type FixturePolicy } from "./policy";
import type { FixtureDomain } from "./index";
import { registerCustomizeSkillFixture } from "./skill-state";
import { fixtureBlobs, pdfDigest } from "./artifacts";
import { fixtureConnectorCuration } from "./connector-curation";

const hour = 60 * 60 * 1000;

function sampleRoutines(now: number): Routine[] {
  const make = (
    id: string,
    name: string,
    description: string,
    repeat: RoutineRepeat,
    extra: Partial<Routine> = {},
  ): Routine => ({
    id,
    name,
    description,
    prompt: `${description} Report what you find.`,
    mode: "code",
    cwd: "/Users/ada/Projects/claudex",
    providerId: "fixture",
    model: "Opus 5.5",
    defaultModel: true,
    frequency: frequencyFor(repeat),
    nextRunAt: nextRun(repeat, now) ?? now,
    enabled: true,
    repeat,
    createdAt: now - 9 * 24 * hour,
    updatedAt: now - 2 * 24 * hour,
    ...extra,
  });
  return [
    make(
      "r-review",
      "daily-code-review",
      "Review yesterday's commits and flag anything concerning.",
      { kind: "weekdays", time: "09:00" },
      {
        lastRunAt: now - 3 * hour,
        lastRunStatus: "completed",
        conversationId: "c-3",
      },
    ),
    make(
      "r-issues",
      "issue-triage",
      "Review and categorize incoming issues, bugs, and feature requests.",
      { kind: "weekdays", time: "09:30" },
      { lastRunAt: now - 60_000, lastRunStatus: "running" },
    ),
    make(
      "r-deps",
      "dependency-update-check",
      "Scan for outdated packages, security patches, and breaking changes.",
      { kind: "weekly", time: "09:00", day: 2 },
    ),
    make(
      "r-flaky",
      "flaky-test-tracker",
      "Find tests that pass and fail intermittently across recent CI runs.",
      { kind: "custom", time: "07:00", days: [2, 3, 4, 5, 6] },
      {
        lastRunAt: now - 29 * hour,
        lastRunStatus: "failed",
        lastError: "The model service is unavailable.",
      },
    ),
    make(
      "r-notes",
      "release-notes",
      "Draft release notes from the pull requests merged since the last tag.",
      { kind: "manual" },
      { defaultModel: false, model: "Sonnet 5", updatedAt: now - hour },
    ),
    make(
      "r-health",
      "nightly-health-check",
      "Check the local services for errors and slow responses.",
      { kind: "daily", time: "02:00" },
      { enabled: false },
    ),
  ];
}

const skillsRoot = "/Users/ada/Library/Application Support/Claudex/profile";
const skill = (
  name: string,
  description: string,
  scope: CustomizeSkill["scope"],
  editedAt: number,
  enabled = true,
): CustomizeSkill => ({
  name,
  description,
  path:
    scope === "user"
      ? `${skillsRoot}/codex-home/skills/${name}/SKILL.md`
      : `/Applications/Claudex.app/Contents/Resources/skills/${name}/SKILL.md`,
  scope,
  enabled,
  editedAt,
  own: scope === "user",
});

/** Two skills bundled with the agent, and with skills=some three of the person's. */
function sampleSkills(now: number, own: boolean): CustomizeSkill[] {
  const day = 24 * hour;
  return [
    ...(own
      ? [
          skill(
            "release-notes",
            "Draft release notes from merged pull requests in the house style.",
            "user",
            now - 2 * day,
          ),
          skill(
            "sql-review",
            "Review SQL migrations for locking, missing indexes and irreversible steps.",
            "user",
            now - 9 * day,
          ),
          skill(
            "meeting-notes",
            "Turn a transcript into decisions, owners and follow-ups.",
            "user",
            now - 40 * day,
            false,
          ),
        ]
      : []),
    skill(
      "skill-creator",
      "Guide for creating effective skills that extend what the agent can do.",
      "system",
      now - 12 * day,
    ),
    skill(
      "plan-review",
      "Check an implementation plan for gaps before any code is written.",
      "system",
      now - 12 * day,
    ),
  ];
}

function sampleProjects(origin: number): Project[] {
  const day = 24 * hour;
  const project = (
    id: string,
    name: string,
    description: string,
    age: number,
    extra: Partial<Project> = {},
  ): Project => ({
    id,
    visibility: "private",
    name,
    description,
    instructions: "",
    createdAt: origin - age * day,
    ...extra,
  });
  return [
    project(
      "p-site",
      "Marketing site",
      "Copy, layout reviews and launch checklists for the new marketing site. Keeps the tone guide and the page inventory in one place.",
      40,
      {
        instructions:
          "Write in plain, friendly English. Prefer short sentences and concrete examples.",
        cwd: "/Users/ada/Projects/site",
      },
    ),
    project(
      "p-research",
      "Robot arm research",
      "Papers, notes and experiments on low-cost manipulators.",
      20,
    ),
    project("p-trip", "Kyoto trip", "", 12),
    project(
      "p-infra",
      "Home lab",
      "Server setup, backups and the network map.",
      70,
    ),
    project(
      "p-book",
      "Reading notes",
      "Summaries and quotes from this year's books.",
      5,
    ),
  ];
}

const sampleServers: McpServerState[] = [
  { name: "docs", state: "ready", tools: 6, command: "docs-mcp" },
  {
    name: "browser",
    state: "failed",
    tools: 0,
    command: "browser-mcp",
    error: "The program exited before it answered.",
  },
];

export const collectionsFixture: FixtureDomain = {
  params: {
    routines: "some: six saved routines in different states",
    routinesPolicy: "off|limit: routines turned off, or at most 3",
    routineHistory:
      "pages: 205 explicitly synthetic review-task runs for cursor paging",
    taskDevices: "some: explicit synthetic local computer identity",
    scheduledSetup: "complete: explicit paused synthetic task creation receipt",
    routineRemote:
      "available: explicit synthetic second backend for native menus",
    routineWorkspace:
      "missing|permission|error: explicit synthetic saved-task folder diagnostics",
    deviceTrust:
      "some: explicit offline task host and pending trusted-client request",
    routineRecovery:
      "missing|restored: synthetic auto-disabled workspace recovery",
    schedulePreview: "error: synthetic execution-side preview failure",
    folder: "1: the folder picker returns a project folder",
    skills: "some: three skills of the person's besides the built-in ones",
    mcp: "none: no connectors configured",
    connectorCuration:
      "some: three synthetic Fixture connectors and a Fixture directory curator",
    projects: "some: five projects, the first with three chats",
    projectContext: "some: explicitly synthetic classic context-file creation",
    knowledge:
      "some|preview: synthetic project context; preview adds a CSV and an existing valid PDF",
    designSystems: "some: two design systems (one written, one a draft)",
    plugins: "some|error: a synced marketplace, or the runtime failing",
  },
  bridge: ({ params, emit, state, origin }) => {
    const now = Date.now();
    if (params.get("projects") === "some" && !state.projects.length) {
      state.projects = sampleProjects(origin);
      // The first project holds a few of the fixture's chats.
      for (const c of state.conversations
        .filter((c) => c.mode !== "code")
        .slice(0, 3))
        c.projectId = state.projects[0].id;
    }
    // Context files per project: eight HTML files, or none.
    const kept = new Map<string, KnowledgeFile[]>();
    const contents = new Map<string, string>();
    if (
      ["some", "preview"].includes(params.get("knowledge") ?? "") &&
      state.projects[0]
    )
      kept.set(
        state.projects[0].id,
        [
          ["test_result.html", 10600],
          ["test_form.html", 9100],
          ["select_template.html", 8100],
          ["header.html", 4400],
          ["footer.html", 2700],
          ["change_password.html", 6400],
          ["template_new.html", 5700],
          ["template_list.html", 7000],
        ].map(([name, bytes], index) => ({
          name: name as string,
          bytes: bytes as number,
          addedAt: origin - index * hour,
        })),
      );
    for (const [id, files] of kept)
      for (const file of files)
        contents.set(
          `${id}/${file.name}`,
          `<!-- Synthetic local acceptance fixture. -->\n<h1>${file.name}</h1>\n`.padEnd(
            file.bytes,
            " ",
          ),
        );
    const previewProject =
      params.get("knowledge") === "preview" ? state.projects[0]?.id : undefined;
    if (previewProject) {
      const csv = "item,value\nalpha,1\nbeta,2\n";
      contents.set(`${previewProject}/project-sample.csv`, csv);
      kept.get(previewProject)!.push(
        {
          name: "project-sample.csv",
          bytes: new TextEncoder().encode(csv).length,
          addedAt: origin,
        },
        {
          name: "summary.pdf",
          bytes: atob(fixtureBlobs[pdfDigest]).length,
          addedAt: origin,
        },
      );
    }
    const knowledge = (id: string): ProjectKnowledge => {
      const files = kept.get(id) ?? [];
      return {
        files: structuredClone(files),
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        limit: 100 * 1000 * 1000,
        fileLimit: 10 * 1000 * 1000,
      };
    };
    // Design systems, kept in memory; Generate answers after a moment.
    const sampleGuidelines =
      "# Mission Impastabowl\n\nWarm, appetising and quick: rounded shapes on cream, tomato red for action.\n\n## Colour\n\n| Token | Hex | Use |\n| --- | --- | --- |\n| --tomato | #d9482b | Buttons, links |\n| --cream | #fbf3e4 | Page background |\n| --basil | #3f6b3a | Success |\n\n## Typography\n\nFraunces for headings, Inter for text; 16/24 body, 32/38 titles.\n\n## CSS variables\n\n```css\n:root { --tomato: #d9482b; --cream: #fbf3e4; --basil: #3f6b3a; }\n```";
    let designs: DesignSystem[] =
      params.get("designSystems") === "some"
        ? [
            {
              id: "ds-1",
              name: "Mission Impastabowl",
              blurb: "Fast-casual pasta restaurant with a kiosk and an app.",
              notes: "",
              sources: [
                { name: "tokens.css", text: ":root { --tomato: #d9482b; }" },
              ],
              guidelines: sampleGuidelines,
              createdAt: origin - 3 * hour,
              updatedAt: origin - 2 * hour,
              generatedAt: origin - 2 * hour,
            },
            {
              id: "ds-2",
              name: "Northwind Docs",
              blurb: "Developer documentation for an API company.",
              notes: "Quiet, dense, monospace accents.",
              sources: [],
              guidelines: "",
              createdAt: origin - 26 * hour,
              updatedAt: origin - 26 * hour,
            },
          ]
        : [];
    // Plugins: one synced marketplace kept in memory.
    const marketplacePath =
      "/home/user/.codex/.tmp/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json";
    const plugin = (
      name: string,
      category: string,
      developer: string | undefined,
      installed = false,
      description?: string,
    ): PluginEntry => ({
      id: `${name}@claude-plugins-official`,
      name,
      title: name,
      marketplace: "claude-plugins-official",
      marketplacePath,
      installed,
      enabled: installed,
      installable: true,
      source: "git",
      category,
      ...(developer ? { developer } : {}),
      ...(description ? { description } : {}),
    });
    let marketplaces =
      params.get("plugins") === "some"
        ? [{ name: "claude-plugins-official", path: marketplacePath }]
        : [];
    let pluginList: PluginEntry[] =
      params.get("plugins") === "some"
        ? [
            plugin(
              "agent-sdk-dev",
              "development",
              undefined,
              true,
              "Claude Agent SDK development plugin",
            ),
            plugin("airtable", "productivity", "Airtable"),
            plugin(
              "aws-serverless",
              "deployment",
              "AWS Labs",
              false,
              "Build and deploy serverless applications on AWS.",
            ),
            plugin("figma", "design", "Figma"),
            plugin("github", "development", "GitHub", true),
            plugin("linear", "productivity", "Linear"),
            plugin("security-guidance", "security", "Anthropic"),
            plugin("stripe", "payments", "Stripe"),
          ]
        : [];
    const catalog = (): PluginCatalog => {
      if (params.get("plugins") === "error")
        throw new Error("The agent runtime isn't running.");
      return structuredClone({
        marketplaces: marketplaces.map((item) => ({
          ...item,
          plugins: pluginList.length,
        })),
        plugins: pluginList,
        loadErrors: [],
      });
    };
    let skills = sampleSkills(now, params.get("skills") === "some");
    registerCustomizeSkillFixture(state, {
      get: () => skills,
      set: (next) => {
        skills = next;
      },
    });
    const servers = params.get("mcp") === "none" ? [] : sampleServers;
    let routines: Routine[] =
      params.get("routines") === "some" ? sampleRoutines(now) : [];
    if (["missing", "restored"].includes(params.get("routineRecovery") ?? ""))
      routines = routines.map((routine) =>
        routine.id === "r-review"
          ? {
              ...routine,
              enabled: false,
              endedReason: "auto_disabled_repo_access" as const,
              lastRunStatus: "failed" as const,
              lastRunAt: now - 60_000,
              lastError: "Synthetic fixture: workspace folder is unavailable.",
            }
          : routine,
      );
    // Synthetic renderer data, not an official capture. The existing review
    // task links to an existing fixture conversation and records a manual run.
    const routineHistory: Record<string, RoutineRun[]> = routines.some(
      (task) => task.id === "r-review",
    )
      ? {
          "r-review": [
            {
              id: "synthetic-review-manual-run",
              startedAt: now - 3 * hour,
              finishedAt: now - 3 * hour + 40_000,
              status: "completed",
              trigger: "manual",
              conversationId: "c-3",
              readAt: now - hour,
            },
          ],
        }
      : {};
    if (
      params.get("routineHistory") === "pages" &&
      routines.some((routine) => routine.id === "r-review")
    )
      routineHistory["r-review"] = Array.from({ length: 205 }, (_, index) => ({
        id: `synthetic-page-run-${index}`,
        status: "completed",
        trigger: index % 2 ? "schedule" : "manual",
        startedAt: now - (index + 1) * hour,
        finishedAt: now - (index + 1) * hour + 1000,
        conversationId: "c-3",
        ...(index % 3 ? { readAt: now } : {}),
      }));
    if (
      ["missing", "restored"].includes(params.get("routineRecovery") ?? "") &&
      routines.some((routine) => routine.id === "r-review")
    )
      routineHistory["r-review"] = [
        {
          id: "synthetic-missing-workspace-run",
          status: "failed",
          trigger: "manual",
          startedAt: now - 60_000,
          finishedAt: now - 59_000,
          error: "Synthetic fixture: workspace folder is unavailable.",
        },
        ...(routineHistory["r-review"] ?? []).slice(1),
      ];
    const limits = params.get("routinesPolicy");
    const scheduledTasks: ClientPolicy["scheduledTasks"] =
      limits === "off"
        ? { enabled: false, maxTasks: null }
        : limits === "limit"
          ? { enabled: true, maxTasks: 3 }
          : { enabled: true, maxTasks: null };
    const changed = () => {
      emit({ type: "schedules", schedules: structuredClone(routines) });
      return structuredClone(routines);
    };
    const syntheticClient = {
      id: "1".repeat(64),
      fingerprint: Array(16).fill("1111").join(" "),
      name: "Preview browser",
      platform: "macOS",
      addedAt: new Date(now - 86400000).toISOString(),
    };
    let trust: DeviceTrustState = {
      requireTrustedDevices: false,
      trusted: [],
      pending: params.get("deviceTrust") === "some" ? [syntheticClient] : [],
    };
    const trustChanged = () => {
      emit({ type: "devices-changed" });
      return structuredClone(trust);
    };
    return {
      readProject: async (id: string) => {
        const project = state.projects.find((value) => value.id === id);
        return project
          ? { status: "ready" as const, project: structuredClone(project) }
          : { status: "missing" as const };
      },
      projectCreationCapabilities: async () => ({
        routing: "classic" as const,
        contextFiles: params.get("projectContext") === "some",
        contextText: false,
        localFolders: Boolean(state.host?.capabilities.localFolders),
        educationSuggestions: false,
      }),
      saveProject: async (project, creation) => {
        // Offline preview data only; no disk or official account mutation.
        const context = creation?.context;
        const files = (context?.files ?? []).map((file) => {
          if (file.data.byteLength > 10_000_000)
            throw new Error("Project files can be up to 10 MB.");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            file.data,
          );
          return { name: file.name, text, bytes: file.data.byteLength };
        });
        state.projects = [
          ...state.projects.filter((value) => value.id !== project.id),
          structuredClone(project),
        ];
        if (context) {
          for (const file of files)
            contents.set(`${project.id}/${file.name}`, file.text);
          kept.set(
            project.id,
            files.map((file) => ({
              name: file.name,
              bytes: file.bytes,
              addedAt: now,
            })),
          );
        }
        return structuredClone(project);
      },
      listCoworkDevices: async () =>
        params.get("deviceTrust") === "some"
          ? [
              {
                id: "fixture-device",
                name: "Fixture computer",
                platform: "darwin",
                version: "preview",
                connectedAt: new Date(now - 3600000).toISOString(),
                addedAt: new Date(now - 86400000).toISOString(),
                lastSeenAt: new Date(now - 60000).toISOString(),
                online: true,
                computerAccess: true,
              },
            ]
          : [],
      deviceTrustState: async () => structuredClone(trust),
      setRequireTrustedDevices: async (required: boolean) => {
        trust = { ...trust, requireTrustedDevices: required };
        return trustChanged();
      },
      approveDeviceTrust: async (id: string, fingerprint: string) => {
        const client = trust.pending.find(
          (item) => item.id === id && item.fingerprint === fingerprint,
        );
        if (!client) throw Error("This verification request has expired.");
        trust = {
          ...trust,
          pending: trust.pending.filter((item) => item.id !== id),
          trusted: [...trust.trusted, client],
        };
        return trustChanged();
      },
      rejectDeviceTrust: async (id: string) => {
        trust = {
          ...trust,
          pending: trust.pending.filter((item) => item.id !== id),
        };
        return trustChanged();
      },
      revokeDeviceTrust: async (id: string) => {
        trust = {
          ...trust,
          trusted: trust.trusted.filter((item) => item.id !== id),
        };
        return trustChanged();
      },
      ...(limits
        ? {
            clientPolicy: async () => ({
              ...fixturePolicy(
                (params.get("policy") ?? undefined) as
                  FixturePolicy | undefined,
              ),
              scheduledTasks,
            }),
          }
        : {}),
      ...(params.get("folder") === "1"
        ? { chooseFolder: async () => "/Users/ada/Projects/claudex" }
        : {}),
      listProjectKnowledge: async (id: string) => knowledge(id),
      readProjectKnowledge: async (
        id: string,
        name: string,
      ): Promise<KnowledgePreview> => {
        const file = kept.get(id)?.find((file) => file.name === name);
        const text = contents.get(`${id}/${name}`);
        if (!state.projects.some((project) => project.id === id) || !file)
          throw new Error("This file is no longer in the project.");
        if (id === previewProject && name === "summary.pdf")
          return {
            name,
            bytes: file.bytes,
            kind: "pdf",
            base64: fixtureBlobs[pdfDigest],
          };
        if (text === undefined)
          throw new Error("This file is no longer in the project.");
        return {
          name,
          bytes: new TextEncoder().encode(text).length,
          kind: "text",
          text,
        };
      },
      // This fixture models local files/text, with no linked project sources.
      // Explicit lists prevent the generic unsupported-method proxy returning undefined.
      listProjectKnowledgeRepositories: async () => [],
      listProjectKnowledgeMcpServers: async () => [],
      listProjectKnowledgeDriveConnectors: async () => [],
      addProjectKnowledge: async (id: string) => knowledge(id),
      addProjectKnowledgeText: async (
        id: string,
        file: { name: string; text: string },
      ) => {
        const name = `${file.name}.md`;
        contents.set(`${id}/${name}`, file.text);
        kept.set(id, [
          ...(kept.get(id) ?? []).filter((file) => file.name !== name),
          {
            name,
            bytes: new TextEncoder().encode(file.text).length,
            addedAt: now,
          },
        ]);
        return knowledge(id);
      },
      removeProjectKnowledge: async (id: string, input: string | string[]) => {
        const names = new Set(Array.isArray(input) ? input : [input]);
        for (const name of names) contents.delete(`${id}/${name}`);
        kept.set(
          id,
          (kept.get(id) ?? []).filter((file) => !names.has(file.name)),
        );
        return knowledge(id);
      },
      listPlugins: async () => catalog(),
      readPlugin: async (id: string) => ({
        description:
          pluginList.find((p) => p.id === id)?.description ??
          "Adds skills and connectors for this tool.",
        skills: [{ name: "review", description: "Reviews changes" }],
        apps: [],
        mcpServers: [{ name: "server" }],
        hooks: 0,
      }),
      installPlugin: async (id: string) => {
        pluginList = pluginList.map((p) =>
          p.id === id ? { ...p, installed: true, enabled: true } : p,
        );
        return { appsNeedingAuth: [] };
      },
      uninstallPlugin: async (id: string) => {
        pluginList = pluginList.map((p) =>
          p.id === id ? { ...p, installed: false, enabled: false } : p,
        );
      },
      addPluginMarketplace: async () => {
        marketplaces = [
          { name: "claude-plugins-official", path: marketplacePath },
        ];
        if (!pluginList.length)
          pluginList = [
            plugin(
              "agent-sdk-dev",
              "development",
              undefined,
              false,
              "Claude Agent SDK development plugin",
            ),
            plugin("figma", "design", "Figma"),
          ];
      },
      removePluginMarketplace: async () => {
        marketplaces = [];
        pluginList = pluginList.filter((p) => p.installed);
      },
      upgradePluginMarketplaces: async () => {},
      proposeScheduledTask: async (description: string) =>
        proposeSchedule(description),
      listDesignSystems: async () => structuredClone(designs),
      saveDesignSystem: async (input: DesignSystemInput) => {
        const at = Date.now();
        const existing = designs.find((d) => d.id === input.id);
        const saved: DesignSystem = {
          blurb: "",
          notes: "",
          sources: [],
          guidelines: "",
          createdAt: at,
          ...existing,
          ...input,
          id: existing?.id ?? `ds-${at}`,
          updatedAt: at,
        } as DesignSystem;
        designs = existing
          ? designs.map((d) => (d.id === saved.id ? saved : d))
          : [saved, ...designs];
        return structuredClone(saved);
      },
      deleteDesignSystem: async (id: string) => {
        designs = designs.filter((d) => d.id !== id);
      },
      generateDesignSystem: async (id: string) => {
        await new Promise((done) => setTimeout(done, 900));
        designs = designs.map((d) =>
          d.id === id
            ? {
                ...d,
                guidelines: sampleGuidelines,
                generatedAt: Date.now(),
                updatedAt: Date.now(),
              }
            : d,
        );
        return structuredClone(designs.find((d) => d.id === id)!);
      },
      customizeSkills: async () => structuredClone(skills),
      // This offline browser fixture has no authenticated host cursor service.
      // Advertise absence instead of the generic proxy's empty success, so
      // search uses its explicitly finite catalogue fallback.
      customizeSearch: undefined,
      skillUploadCapabilities: async () => ({ securityScan: false }),
      // Offline synthetic response, not a fetched or complete official catalogue.
      // The UI may still display its existing seed records; no ability is granted.
      listApprovedDirectory: async () => [
        ...(params.get("connectorCuration") === "some"
          ? fixtureConnectorCuration()
          : []),
        // Discover's curated blocks for the sample marketplace's plugins.
        ...(params.get("pluginCuration") === "some"
          ? [
              ["figma", { isNew: true, popular: true }, "2026-10-12"],
              ["linear", { isNew: true }, "2026-10-10"],
              ["stripe", { isNew: true }, "2026-10-08"],
              ["github", { popular: true }, "2026-09-01"],
              ["airtable", { popular: true }, "2026-08-01"],
            ].map(([slug, curation, added]) => ({
              id: `fixture-plugin-${slug}`,
              kind: "plugin" as const,
              name: String(slug),
              slug: String(slug),
              description: "",
              url: "https://fixture.invalid/plugins",
              added: `${added}T00:00:00Z`,
              curation: curation as { isNew?: boolean; popular?: boolean },
            }))
          : []),
      ],
      linearStatus: async () => ({ connected: false }),
      mcpServers: async () => ({
        servers: structuredClone(servers),
        configPath: `${skillsRoot}/mcp.json`,
      }),
      saveSkill: async ({ name, description }) => {
        if (skills.some((s) => s.name === name))
          throw new Error(`A skill named "${name}" is already installed.`);
        skills = [skill(name, description, "user", Date.now()), ...skills];
      },
      uploadSkill: async () => null,
      revealSkill: async () => {},
      listSchedules: async () =>
        structuredClone(
          routines.map((task) => {
            const {
              runCount: _count,
              runCountLimited: _limited,
              ...fields
            } = task;
            return {
              ...fields,
              ...recordedRoutineRunCount(
                routineHistory[task.id] ?? [],
                task.lastRunAt,
              ),
            };
          }),
        ),
      // This offline scheduler has no remote runner or notification service.
      routineWorkspace: async (id: string) => {
        const task = routines.find((value) => value.id === id);
        if (!task) throw new Error("This scheduled task no longer exists.");
        if (params.get("routineWorkspace") === "error")
          throw new Error("Synthetic task folder read failure.");
        const state =
          params.get("routineWorkspace") === "missing"
            ? ("missing" as const)
            : params.get("routineWorkspace") === "permission"
              ? ("permission-required" as const)
              : ("ready" as const);
        return {
          taskId: id,
          host:
            task.environment?.kind === "ssh"
              ? ("ssh" as const)
              : ("local" as const),
          problems: [],
          folders: task.cwd
            ? [
                {
                  path: task.cwd,
                  state,
                  ...(state === "missing"
                    ? {
                        message:
                          "This folder no longer exists. Edit the task to choose another folder.",
                      }
                    : state === "permission-required"
                      ? {
                          message:
                            "This task needs permission to use this folder.",
                        }
                      : {}),
                },
              ]
            : [],
        };
      },
      routineCapabilities: async () => ({
        remote:
          state.host?.kind === "web" ||
          params.get("routineRemote") === "available",
        email: false,
        slack: false,
        setupWithChat: true,
        sources: ["chat", "code"],
        statuses: ["active", "paused", "auto-disabled", "on-hold"],
      }),
      // Explicit offline mail capability; never sends email.
      codeEmailStatus: async () => {
        if (params.get("codeEmail") === "error")
          throw new Error("Synthetic mail availability failure.");
        return { available: params.get("codeEmail") === "available" };
      },
      routineRuns: async (id: string) =>
        structuredClone(routineHistory[id] ?? []),
      routineRunsPage: async (id: string, query?: RoutineRunQuery) => {
        if (!routines.some((routine) => routine.id === id))
          throw new Error("This scheduled task no longer exists.");
        return pageRoutineRuns(
          id,
          structuredClone(routineHistory[id] ?? []),
          query,
        );
      },
      // Explicitly synthetic execution environment: this offline harness
      // executes its typed schedule calculator in the preview browser.
      routineSchedulePreview: async (repeat: RoutineRepeat) => {
        if (params.get("schedulePreview") === "error")
          throw new Error("Synthetic schedule preview unavailable.");
        return {
          nextRunAt: nextRun(validRepeat(repeat), Date.now()) ?? null,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      },
      markRoutineRunRead: async (id: string, runId: string) => {
        routineHistory[id] = (routineHistory[id] ?? []).map((run) =>
          run.id === runId ? { ...run, readAt: Date.now() } : run,
        );
      },
      saveSchedule: async (input: RoutineInput) => {
        const existing = routines.find((r) => r.id === input.id);
        if (
          existing?.endedReason === "auto_disabled_repo_access" &&
          input.enabled &&
          params.get("routineRecovery") !== "restored"
        )
          throw new Error(
            "Restore access to this task’s workspace folder before turning it back on.",
          );
        const nameProblem =
          existing?.name === input.name.trim()
            ? undefined
            : routineNameProblem(input.name, routines, input.id);
        if (nameProblem) throw new Error(nameProblem);
        if (!existing) {
          if (!scheduledTasks.enabled) throw new Error(routinesOffMessage);
          if (
            scheduledTasks.maxTasks !== null &&
            routines.length >= scheduledTasks.maxTasks
          )
            throw new Error(routineLimitMessage(scheduledTasks.maxTasks));
        }
        const at = Date.now();
        const saved: Routine = {
          ...existing,
          ...input,
          endedReason: input.enabled ? undefined : existing?.endedReason,
          ...(input.defaultModel
            ? { providerId: "fixture", model: "Opus 5.5" }
            : {}),
          id: existing?.id ?? `r-${at}`,
          nextRunAt: input.repeat
            ? (nextRun(input.repeat, at) ?? at)
            : input.nextRunAt,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        };
        routines = existing
          ? routines.map((r) => (r.id === saved.id ? saved : r))
          : [...routines, saved];
        changed();
        return structuredClone(saved);
      },
      deleteSchedule: async (id: string) => {
        routines = routines.filter((r) => r.id !== id);
        changed();
      },
      runSchedule: async (id: string) => {
        if (!scheduledTasks.enabled) throw new Error(routinesOffMessage);
        routines = routines.map((r) =>
          r.id === id
            ? { ...r, lastRunAt: Date.now(), lastRunStatus: "running" }
            : r,
        );
        changed();
        return structuredClone(routines.find((r) => r.id === id)!);
      },
    };
  },
};
