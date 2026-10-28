import type { CodeSlashCommand } from "./code-slash-commands";
import type {
  Provider,
  Settings,
  CodeEffort,
  Theme,
} from "../../../shared/types";
import { codeEffortLevels } from "../../../shared/code-effort";
import { formatText, t } from "../../i18n";

type Actions = {
  platform: NodeJS.Platform;
  navigate: (page: string) => void;
  settings: (tab: string) => void;
  model: () => void;
  effort: () => void;
  fast?: () => void;
  permissions: () => void;
  plan: (
    patch: Pick<Settings, "codeSandbox" | "autoAcceptEdits" | "codePlanMode">,
  ) => void;
  usage: () => void;
  /** /status: the Session info card in the open session's transcript. */
  status?: () => void;
  /** /rename [new title]: renames the open session (the title's editor without a title). */
  rename?: (title: string) => void;
  goal?: (goal: string) => void;
  /** /export: saves the open session's transcript. */
  exportSession?: () => void;
  /** /diff: shows or hides the session's changes. */
  diff?: () => void;
  /** /output-style [name]: sets the open session's output style. */
  outputStyle?: (name: string) => void;
  /** /feedback: opens the session feedback form; false when nothing took it (no footer, not allowed). */
  feedback?: () => boolean;
  /** /help: the service's help page, when it has one. */
  help?: () => void;
  /** /tasks and /workflows: opens the session's background tasks. */
  tasks?: () => void;
  loop?: (args: string) => void;
  /** /compact: summarizes the open conversation. */
  compact: () => void;
  /** /fork: forks the open conversation (Composer passes the text after it as the prompt). */
  fork?: () => void;
  /** /handoff: a new session starting from a note about the open one. */
  handOff?: () => void;
  /** /rewind: steps back to before the last message. */
  rewind?: () => void;
  /** /review: Codex reviews the open session (Composer passes the text after it). */
  review?: () => void;
  /** /btw [question]: opens the side chat, asking the question there when given (Composer passes the text after it). */
  btw?: () => void;
  /** /copy [N]: copies the latest reply, or the Nth latest (the text after the command). */
  copy?: (args: string) => void;
  /** A custom prompt or skill: sent as a message (see Composer). */
  custom?: (command: CodeSlashCommand) => void;
  unavailable: (message: string) => void;
  /** The open session runs in its own worktree (/cd can't move it). */
  inWorktree?: boolean;
};

export function executeCodeSlashCommand(
  command: CodeSlashCommand,
  actions: Actions,
  /** The text after the command (/rename's title). */
  args = "",
) {
  if (command.source) {
    if (actions.custom) actions.custom(command);
    else
      actions.unavailable(
        formatText("/{name} can't be run here.", { name: command.name }),
      );
    return;
  }
  switch (command.name) {
    case "resume":
      window.dispatchEvent(
        new CustomEvent("claudex:resume-session", { detail: { query: args } }),
      );
      break;
    case "loop":
      if (actions.loop) actions.loop(args);
      else actions.unavailable("Open a session to see its background tasks.");
      break;
    case "schedule":
      actions.navigate("scheduled");
      break;
    case "tasks":
    case "workflows":
      if (actions.tasks) actions.tasks();
      else actions.unavailable("Open a session to see its background tasks.");
      break;
    case "plugin":
      actions.settings("plugins");
      break;
    case "model":
      actions.model();
      break;
    case "effort":
      actions.effort();
      break;
    case "plan":
      // On every platform, like the permission menu's Plan.
      actions.plan({
        codeSandbox: "read-only",
        autoAcceptEdits: false,
        codePlanMode: true,
      });
      break;
    case "fast":
      if (actions.fast) actions.fast();
      else
        actions.unavailable(
          t(
            "Fast mode unavailable: Fast mode is not available with this agent",
          ),
        );
      break;
    case "permissions":
      actions.permissions();
      break;
    case "skills":
      actions.settings("skills");
      break;
    case "usage":
      actions.usage();
      break;
    case "status":
      if (actions.status) actions.status();
      else actions.unavailable("Open a session to see its status.");
      break;
    case "rename":
      if (actions.rename) actions.rename(args);
      else actions.unavailable("Open a session to rename it.");
      break;
    case "goal":
      if (actions.goal) actions.goal(args);
      else actions.unavailable(t("Open a session to set its goal."));
      break;
    case "export":
      if (actions.exportSession) actions.exportSession();
      else actions.unavailable("Open a session to export it.");
      break;
    case "diff":
      if (actions.diff) actions.diff();
      else actions.unavailable("Open a session to see its changes.");
      break;
    case "output-style":
      if (actions.outputStyle) actions.outputStyle(args.trim());
      else actions.unavailable("Open a session to set its output style.");
      break;
    case "feedback":
      if (!actions.feedback?.())
        actions.unavailable("Feedback isn’t available for this session.");
      break;
    case "autocompact":
      window.dispatchEvent(new Event("claudex:context-popover"));
      break;
    case "config":
    case "sandbox":
      actions.settings("code");
      break;
    case "storage":
      actions.settings("system");
      break;
    case "login":
      actions.settings("account");
      break;
    case "help":
      if (actions.help) actions.help();
      else actions.unavailable("Help isn't set up for this service.");
      break;
    case "copy":
      if (actions.copy) actions.copy(args);
      else actions.unavailable("There’s no reply to copy yet.");
      break;
    case "usage-credits":
      actions.settings("billing");
      break;
    case "mcp":
      actions.settings("connectors");
      break;
    case "compact":
      actions.compact();
      break;
    case "rewind":
      if (actions.rewind) actions.rewind();
      else actions.unavailable("Rewind isn't available for this session.");
      break;
    case "fork":
      if (actions.fork) actions.fork();
      else actions.unavailable("Fork isn't available for this session.");
      break;
    case "handoff":
      if (actions.handOff) actions.handOff();
      else actions.unavailable("Hand off isn't available for this session.");
      break;
    case "btw":
      if (actions.btw) actions.btw();
      else actions.unavailable("Open a session to use side chat");
      break;
    case "theme":
      actions.settings("general");
      break;
    case "review":
      if (actions.review) actions.review();
      else actions.unavailable("Open a session to review its changes.");
      break;
    case "cd":
      // A worktree session keeps its folder.
      actions.unavailable(
        actions.inWorktree
          ? "This session runs in an isolated worktree, so its folder can't be changed."
          : formatText("/{name} is not available in this client yet.", {
              name: command.name,
            }),
      );
      break;
    default:
      actions.unavailable(
        formatText("/{name} is not available in this client yet.", {
          name: command.name,
        }),
      );
  }
}

export function resolveCodeSlashArgument(
  name: string,
  argument: string,
  providers: Provider[],
  preferredProviderId: string,
):
  | { kind: "action" }
  | { kind: "model"; providerId: string; model: string }
  | { kind: "effort"; value: CodeEffort }
  | { kind: "theme"; value: Theme }
  /** /autocompact: the token count compaction waits for; 0 is the model's own. */
  | { kind: "autocompact"; tokens: number }
  | { kind: "error"; message: string } {
  const value = argument.trim();
  if (!value) return { kind: "action" };
  if (name === "model") {
    const preferred = providers.find(
      (provider) => provider.id === preferredProviderId,
    );
    for (const provider of [preferred, ...providers].filter(
      (item): item is Provider => Boolean(item),
    )) {
      const model = [provider.model, ...provider.models].find(
        (candidate) => candidate.toLowerCase() === value.toLowerCase(),
      );
      if (model) return { kind: "model", providerId: provider.id, model };
    }
    return {
      kind: "error",
      message: formatText("Unknown model: {value}", { value }),
    };
  }
  if (name === "effort") {
    const level = codeEffortLevels.find(
      (candidate) => candidate === value.toLowerCase(),
    );
    return level
      ? { kind: "effort", value: level }
      : {
          kind: "error",
          message: formatText("Unknown effort level: {value}", { value }),
        };
  }
  if (name === "autocompact") {
    if (value.toLowerCase() === "auto")
      return { kind: "autocompact", tokens: 0 };
    const count = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.replace(/,/g, ""));
    const tokens = count
      ? Math.round(
          Number(count[1]) *
            ({ k: 1_000, m: 1_000_000 }[count[2]?.toLowerCase() ?? ""] ?? 1),
        )
      : 0;
    return tokens >= 1_000 && tokens <= 100_000_000
      ? { kind: "autocompact", tokens }
      : { kind: "error", message: `Unknown auto-compact setting: ${value}` };
  }
  if (name === "theme") {
    const themes: Record<string, Theme> = {
      light: "light",
      dark: "dark",
      system: "system",
      auto: "system",
    };
    const theme = themes[value.toLowerCase()];
    return theme
      ? { kind: "theme", value: theme }
      : {
          kind: "error",
          message: formatText("Unknown theme: {value}", { value }),
        };
  }
  return { kind: "action" };
}
