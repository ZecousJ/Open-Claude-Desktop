import fs from "node:fs";
import { finishTurn } from "../../shared/activity";
import path from "node:path";
import type { Conversation, Project, Settings } from "../../shared/types";
import { defaultSidebarWidth } from "../../shared/sidebar-layout";
export const defaultSettings: Settings = {
  theme: "dark",
  sidebarWidth: defaultSidebarWidth,
  name: "",
  providers: [
    {
      id: "default",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "responses",
      model: "",
      models: [],
    },
  ],
  activeProviderId: "default",
  effort: "high",
  codeEffort: "medium",
  sandbox: "workspace-write",
  codeSandbox: "workspace-write",
  autoAcceptEdits: false,
  codePlanMode: false,
  instructions: "",
  mcpServers: {},
};
/**
 * Earlier versions stored this note as the error of a turn cut off by the app
 * closing; such turns now carry stopReason "restart" instead.
 */
const legacyRestartNote =
  "\u4e0a\u6b21\u5e94\u7528\u5173\u95ed\u65f6\u4efb\u52a1\u88ab\u4e2d\u65ad\uff0c\u53ef\u4ee5\u53d1\u9001\u6d88\u606f\u7ee7\u7eed\u3002";

/** These stores have account owners and no project sharing operation. Migrate
 * only missing metadata; an explicit unknown/non-private value is not a grant
 * to relabel it (Go webstore/store.go listProjects/putProject use user_id). */
export function projectWithVisibility(project: Project): Project {
  return Object.hasOwn(project, "visibility")
    ? project
    : { ...project, visibility: "private" };
}

export class Store {
  settings: Settings;
  conversations: Conversation[];
  projects: Project[];
  private timer?: NodeJS.Timeout;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const savedSettings = this.read("settings.json", {});
    this.settings = {
      ...structuredClone(defaultSettings),
      ...savedSettings,
      sidebarWidth:
        Number.isInteger(savedSettings.sidebarWidth) &&
        savedSettings.sidebarWidth >= 188 &&
        savedSettings.sidebarWidth <= 460
          ? savedSettings.sidebarWidth
          : defaultSettings.sidebarWidth,
      codeEffort:
        savedSettings.codeEffort ??
        (["low", "medium", "high", "xhigh", "max"].includes(
          savedSettings.effort,
        )
          ? savedSettings.effort
          : defaultSettings.codeEffort),
      codeSandbox:
        savedSettings.codeSandbox ??
        savedSettings.sandbox ??
        defaultSettings.codeSandbox,
    };
    this.conversations = this.read("conversations.json", []);
    const savedProjects: Project[] = this.read("projects.json", []);
    this.projects = savedProjects.map(projectWithVisibility);
    if (
      this.projects.some((project, index) => project !== savedProjects[index])
    )
      this.write("projects.json", this.projects);
    for (const c of this.conversations)
      for (const t of [
        c.turns,
        ...(c.savedBranches ?? []).map((b) => b.turns),
      ].flat())
        if (t.status === "inProgress") {
          // The transcript marks these as stopped by the app closing.
          finishTurn(t, "interrupted");
          t.stopReason = "restart";
          delete t.reconnecting;
        } else if (
          t.status === "interrupted" &&
          t.error === legacyRestartNote
        ) {
          t.stopReason = "restart";
          delete t.error;
        }
  }
  private read(name: string, fallback: any) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return fallback;
      throw new Error(
        `${name} couldn't be read. To protect your history, the app did not overwrite it.`,
      );
    }
  }
  write(name: string, value: unknown) {
    const target = path.join(this.root, name);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    // History imports and account/device copies also enter the project list.
    this.projects = this.projects.map(projectWithVisibility);
    this.write("settings.json", this.settings);
    // Incognito chats never reach disk.
    this.write(
      "conversations.json",
      this.conversations.filter((c) => !c.incognito),
    );
    this.write("projects.json", this.projects);
  }
  schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 750);
  }
  conversation(id: string) {
    const c = this.conversations.find((c) => c.id === id);
    if (!c) throw new Error("Conversation not found.");
    return c;
  }
}
