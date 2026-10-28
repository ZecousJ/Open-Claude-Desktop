/**
 * Desktop and developer Settings pages: System, storage, Developer/Connectors
 * server states and Skills. Listed in index.ts since the 2026-09-28 settings
 * audit.
 *
 * URL parameters:
 * - `mcp=failed` the second server failed to start (Developer, Connectors)
 * - `mcp=none` no servers configured (empty states)
 * - `skills=none` the runtime lists no skills
 * - `startup=1` Run on startup is on
 */
import type {
  McpServers,
  StorageUsage,
  SystemState,
} from "../../../shared/settings-desktop-api";
import type { FixtureDomain } from "./index";
import type { LocalMcpDiscovery } from "../../../shared/settings-mcp-api";
import { customizeSkillFixture } from "./skill-state";

const folder = "/Users/fixture/Library/Application Support/Claudex/accounts/a1";

const storage = (cache: number): StorageUsage => ({
  computedAt: Date.now() - 60_000,
  incomplete: false,
  folder,
  cowork: {
    count: 38,
    chatCount: 21,
    historyBytes: 192_212_000,
    filesBytes: 31_400_000,
    pluginsAndSkillsBytes: 1_260_000,
    workspaceBytes: 23_900_000,
    otherBytes: 4_100_000,
    stale: { olderThanDays: 30, count: 12, bytes: 84_300_000 },
  },
  code: { sessionCount: 9, historyBytes: 57_800_000, scratchBytes: 310_000 },
  runtime: { versionCount: 1, bytes: 61_200_000 },
  app: {
    webCacheBytes: cache,
    browserPanesBytes: 12_800_000,
    logsBytes: 9_700_000,
    otherCachesBytes: 0,
  },
});

const skills = [
  {
    name: "weekly-report",
    description:
      "Turn the week's merged pull requests into a short status report for the team.",
    path: `${folder}/codex-home/skills/weekly-report/SKILL.md`,
    scope: "user",
    enabled: true,
  },
  {
    name: "release-notes",
    description: "Draft release notes from the changelog and tagged commits.",
    path: `${folder}/codex-home/skills/release-notes/SKILL.md`,
    scope: "user",
    enabled: false,
  },
  {
    name: "skill-creator",
    description:
      "Create new skills, modify and improve existing skills, and measure skill performance.",
    path: "/Applications/Claudex.app/Contents/Resources/skills/skill-creator/SKILL.md",
    scope: "system",
    enabled: true,
  },
];
const skillPreviewFiles = [
  "SKILL.md",
  "agents/analyzer.md",
  "agents/grader.md",
  "assets/eval_review.html",
  "references/schemas.md",
  "scripts/generate_report.py",
];

export const settingsDesktopFixture: FixtureDomain = {
  params: {
    mcp: "failed | none",
    skills: "none",
    startup: "1",
  },
  bridge: ({ params, state }) => {
    let runOnStartup = params.get("startup") === "1";
    let cache = 48_300_000;
    const listed =
      params.get("skills") === "none" ? [] : structuredClone(skills);
    const system = (): SystemState => ({
      runOnStartup,
      shortcutChoices: [
        "Option+Space",
        "Command+Shift+Space",
        "Control+Option+Space",
      ],
      dataFolder: folder,
    });
    return {
      systemState: async () => system(),
      setRunOnStartup: async (enabled) => {
        runOnStartup = enabled;
        return system();
      },
      revealDataFolder: async () => {},
      storageUsage: async () => storage(cache),
      clearCacheAndRestart: async () => {
        cache = 0;
        return true;
      },
      previewStorageCleanup: async (kind, days) => ({
        preview: {
          token: "00000000-0000-4000-8000-000000000000",
          kind,
          olderThanDays: days,
          count: kind === "code" ? 3 : 12,
          chatCount: kind === "code" ? 0 : 5,
          bytes: 84_300_000,
          examples: [
            { title: "Quarterly planning notes", bytes: 12_000_000 },
            { title: "Summarize the onboarding survey", bytes: 8_400_000 },
          ],
          unverifiedCount: 0,
        },
      }),
      runStorageCleanup: async () => ({
        deletedCount: 12,
        skippedCount: 0,
        failedCount: 0,
        failedInUseCount: 0,
        cancelled: false,
      }),
      cancelStorageCleanup: async () => {},
      openMcpConfig: async () => {},
      readMcpLogs: async (name: string) => {
        if (!Object.hasOwn(state.settings.mcpServers, name))
          throw new Error("This MCP server no longer exists.");
        if (params.get("mcpLogs") === "error")
          throw new Error("Synthetic MCP log failure.");
        return {
          name,
          kind: "connection-events" as const,
          lines: params.get("mcpLogs") === "some"
            ? ["2026-10-19T00:00:00.000Z ready: Fixture connection event"] : [],
          truncated: false,
        };
      },
      discoverLocalMcp: async (): Promise<LocalMcpDiscovery> => {
        if (params.get("mcpImport") === "error")
          throw new Error("Synthetic local MCP discovery failure.");
        return {
          token: "00000000-0000-4000-8000-000000000029",
          sources: [{ name: "Fixture local configuration", state: "read" }],
          candidates: params.get("mcpImport") === "some" ? [{
            id: "00000000-0000-4000-8000-000000000034",
            name: "fixture-notes", source: "Fixture local configuration",
            state: Object.hasOwn(state.settings.mcpServers, "fixture-notes") ? "duplicate" : "available",
            reason: Object.hasOwn(state.settings.mcpServers, "fixture-notes") ? "Already set up." : undefined,
            preview: '{"command":"node","args":["/fixture/notes-mcp.js"],"env":{"TOKEN":"[redacted]"}}',
          }] : [],
        };
      },
      importLocalMcp: async ({token, ids}: {token: string; ids: string[]}) => {
        if (params.get("mcpImport") !== "some" ||
            token !== "00000000-0000-4000-8000-000000000029" ||
            ids.length !== 1 || ids[0] !== "00000000-0000-4000-8000-000000000034" ||
            Object.hasOwn(state.settings.mcpServers, "fixture-notes"))
          throw new Error("Synthetic MCP selection is unavailable.");
        state.settings.mcpServers["fixture-notes"] = {
          command: "node", args: ["/fixture/notes-mcp.js"], enabled: false,
        };
        return { imported: ["fixture-notes"], disabled: true as const };
      },
      mcpServers: async (): Promise<McpServers> => {
        if (params.get("mcp") === "none") state.settings.mcpServers = {};
        const failed = params.get("mcp") === "failed";
        return {
          configPath: `${folder}/mcp-config.json`,
          servers: Object.entries(state.settings.mcpServers).map(
            ([name, raw], index) => {
              const config = raw as { command?: string; args?: string[] };
              const broken = failed && index === 1;
              return {
                name,
                state: broken ? "failed" : "ready",
                error: broken
                  ? "MCP client for `browser` failed to start: program not found"
                  : undefined,
                tools: broken ? 0 : 4 + index,
                command: [config.command, ...(config.args ?? [])].join(" "),
              };
            },
          ),
        };
      },
      listSkills: async () => [
        { cwd: folder, skills: structuredClone(listed), errors: [] },
      ],
      setSkillEnabled: async (path, enabled) => {
        const custom = customizeSkillFixture(state);
        const knownCustomize = custom?.has(path);
        if (custom && knownCustomize) custom.setEnabled(path, enabled);
        const skill = listed.find((item) => item.path === path);
        if (skill) skill.enabled = enabled;
        else if (!knownCustomize)
          throw new Error("This skill is not in the offline fixture.");
      },
      // A skill's page: its folder and one file's text.
      readSkill: async (path) => {
        // A known legacy Settings sample retains its original contents. Other
        // explicit Customize paths read the inventory registered by collections.
        if (listed.some((item) => item.path === path))
          return {
            markdown: "# Skill Creator\n\nA skill for creating new skills.",
            files: skillPreviewFiles.map((path) => ({ path, bytes: 1200 })),
            truncated: false,
          };
        const custom = customizeSkillFixture(state);
        if (custom?.has(path)) return custom.read(path);
        throw new Error("This skill is not in the offline fixture.");
      },
      readSkillFile: async (path, file) => {
        if (listed.some((item) => item.path === path)) {
          if (!skillPreviewFiles.includes(file))
            throw new Error("This file is not in the offline skill bundle.");
          return {
            text: file.endsWith(".md")
              ? "# Skill Creator\n\nA skill for creating new skills and iteratively improving them.\n\nAt a high level, the process of creating a skill goes like this:\n\n- Decide what you want the skill to do\n- Write a draft of the skill\n- Create a few test prompts"
              : "print('report')\n",
            truncated: false,
            binary: false,
          };
        }
        const custom = customizeSkillFixture(state);
        if (custom?.has(path)) return custom.readFile(path, file);
        throw new Error("This skill is not in the offline fixture.");
      },
      uploadSkill: async () => null,
      revealSkill: async () => {},
      deleteSkill: async (path) => {
        const custom = customizeSkillFixture(state);
        const knownCustomize = custom?.has(path);
        if (custom && knownCustomize) custom.remove(path);
        const at = listed.findIndex((item) => item.path === path);
        if (at >= 0) {
          if (listed[at].scope !== "user")
            throw new Error("This skill cannot be removed from the offline fixture.");
          listed.splice(at, 1);
        } else if (!knownCustomize)
          throw new Error("This skill is not in the offline fixture.");
      },
      saveSkill: async (skill) => {
        listed.push({
          name: skill.name,
          description: skill.description,
          path: `${folder}/codex-home/skills/${skill.name}/SKILL.md`,
          scope: "user",
          enabled: true,
        });
      },
    };
  },
};
