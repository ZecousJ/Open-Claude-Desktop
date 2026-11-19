import type { CustomSlashCommand } from "../../../shared/composer-api";

export type CodeSlashCommand = {
  name: string;
  description: string;
  /** Other names that find and run it ("/stats" for /usage). */
  aliases?: string[];
  /** Only in an open, idle conversation (/compact). */
  conversation?: boolean;
  /** Only with a session open: the host registry's hasSession gate (/rewind, /status, /copy). */
  session?: boolean;
  /** Added by the person: a custom prompt ("Custom command") or a skill (R-0401). */
  source?: CustomSlashCommand["source"];
  argumentHint?: string;
  /** Runs when typed but is not in the unfiltered list. */
  typedOnly?: boolean;
};

/**
 * The Code slash list in the original's order, with its descriptions,
 * argument hints and aliases (live claude.ai bundle, 2026-10-14, the host
 * command registry). Commands the original keeps behind flags or for its
 * own services (subtask, context, memory, logs, advisor, Ultrareview
 * launching a remote session) are left out; those Claudex lacks the feature
 * for say so when run (code-slash-actions.ts).
 */
export const codeSlashCommands: CodeSlashCommand[] = [
  {
    name: "schedule",
    description:
      "Create a scheduled task that can be run on demand or automatically on an interval.",
  },
  {
    name: "btw",
    aliases: ["side"],
    description: "Ask a quick side question without adding to the session",
    session: true,
  },
  // The live app lists /ultrareview only where the host can launch a remote
  // review session (cc183b3ab: gate on ipc.launchUltrareview); Claudex has
  // no such session, and /review runs the local review.
  {
    name: "rewind",
    description: "Rewind the session to an earlier message",
    session: true,
  },
  {
    name: "fork",
    description: "Fork this session into a new one",
    argumentHint: "[prompt]",
    session: true,
  },
  { name: "mcp", description: "Manage MCP connectors" },
  {
    name: "plugin",
    aliases: ["plugins", "marketplace"],
    description: "Manage Claudex Code plugins",
    argumentHint: "[install]",
  },
  {
    name: "feedback",
    aliases: ["bug", "share"],
    description: "Send feedback, report a bug, or share your session",
    argumentHint: "[report]",
    session: true,
  },
  {
    name: "model",
    description: "Set the model for this session",
    argumentHint: "[model-id]",
  },
  {
    name: "effort",
    description: "Set the effort level for this session",
    argumentHint: "[level]",
  },
  {
    name: "fast",
    description: "Turn fast mode on or off",
    argumentHint: "[on|off]",
  },
  {
    name: "plan",
    description: "Switch to plan mode or view this session’s plan",
    argumentHint: "[open|<description>]",
  },
  {
    name: "permissions",
    aliases: ["allowed-tools"],
    description: "Change the permission mode",
  },
  { name: "skills", description: "Browse and manage your skills" },
  {
    name: "output-style",
    description: "Set the output style for this session",
    argumentHint: "[style]",
    session: true,
  },
  {
    name: "goal",
    description: "Set or clear the goal for this session",
    argumentHint: "[goal]",
    conversation: true,
  },
  {
    name: "rename",
    aliases: ["name"],
    description: "Rename this session",
    argumentHint: "[new title]",
    session: true,
  },
  {
    name: "export",
    description: "Export this session’s transcript",
    session: true,
  },
  {
    name: "add-dir",
    description: "Add another folder to this session",
    argumentHint: "[path]",
    session: true,
    // A session works in one folder (docs/parity-audit-2026-10-15.md), so the
    // list does not offer it; typed, it says so.
    typedOnly: true,
  },
  {
    name: "cd",
    description: "Move this session to a new working directory",
    argumentHint: "[path]",
    session: true,
  },
  {
    name: "diff",
    description: "Show or hide this session’s changes",
    session: true,
  },
  {
    name: "loop",
    description: "Recurring loop",
    argumentHint: "[interval] <prompt>",
    conversation: true,
  },
  {
    name: "tasks",
    aliases: ["bashes"],
    description: "Show this session’s background tasks",
    session: true,
  },
  {
    name: "workflows",
    aliases: ["workflow"],
    description: "Browse workflow history (running and completed)",
  },
  {
    name: "status",
    description: "Show this session’s version, model, environment, and account",
    session: true,
  },
  {
    name: "usage",
    aliases: ["stats", "cost"],
    description: "Show plan usage and rate limits",
  },
  {
    name: "usage-credits",
    aliases: ["extra-usage"],
    description: "Open usage settings",
  },
  {
    name: "autocompact",
    description: "Show context usage or set when auto-compact runs",
    argumentHint: "[auto|<tokens>]",
    session: true,
  },
  {
    name: "config",
    aliases: ["settings"],
    description: "Open Claudex Code settings",
  },
  {
    name: "storage",
    description: "See how much space Claudex uses on this computer",
  },
  { name: "sandbox", description: "Open Claudex Code sandbox settings" },
  {
    name: "theme",
    description: "Set the appearance (system, light, or dark)",
    argumentHint: "[system|light|dark]",
  },
  {
    name: "resume",
    aliases: ["continue"],
    description:
      "Search and continue a Claudex Code session from this computer",
    argumentHint: "[search]",
  },
  { name: "login", aliases: ["logout"], description: "Sign in again" },
  { name: "help", description: "Get help and support" },
  // Live claude.ai bundle, 2026-10-16, cc183b3ab: after /help, [N], only
  // with a session.
  {
    name: "copy",
    description:
      "Copy Claudex’s latest reply, or /copy 2 or higher for an earlier one",
    argumentHint: "[N]",
    session: true,
  },
  // Claudex's own, typed only: Codex reviews the session's changes; a
  // session hands itself off to a new one from a note.
  {
    name: "review",
    description: "Review the changes in this session",
    conversation: true,
    typedOnly: true,
  },
  {
    name: "handoff",
    description: "Continue in a new session from a note about this one",
    conversation: true,
    typedOnly: true,
  },
];

/** The built-in command a typed name or alias stands for. */
export function builtInSlashCommand(name: string) {
  const key = name.toLowerCase();
  return codeSlashCommands.find(
    (command) => command.name === key || command.aliases?.includes(key),
  );
}

/**
 * The grey tag at the right of a row (R-0401): the person's own prompts say
 * "Custom command"; skills carry no tag (their plugin prefix, as in
 * "anthropic-skills:docs", is part of the name).
 */
export const slashSourceLabels: Record<
  CustomSlashCommand["source"],
  string | undefined
> = {
  prompt: "Custom command",
  skill: undefined,
};

/**
 * The commands that apply now: the session commands only with a session
 * open (a draft lists none), /compact only in an open conversation that
 * is not running, /usage-credits only with a Sub2API account (its Billing
 * page), then the person's own prompts and skills. A built-in command keeps
 * its name; an added one with the same name is not listed.
 */
export function availableCodeSlashCommands({
  conversationIdle,
  hasSession = true,
  planAllowed,
  usageCredits = false,
  custom = [],
}: {
  conversationIdle: boolean;
  /** A session is open; a draft lists none of the session commands (the registry's hasSession gate). */
  hasSession?: boolean;
  planAllowed: boolean;
  usageCredits?: boolean;
  custom?: CustomSlashCommand[];
}): CodeSlashCommand[] {
  const builtIn = codeSlashCommands.filter(
    (command) =>
      (!command.conversation || conversationIdle) &&
      (!command.session || hasSession) &&
      (command.name !== "plan" || planAllowed) &&
      (command.name !== "usage-credits" || usageCredits),
  );
  const reserved = new Set(
    codeSlashCommands.flatMap((command) => [
      command.name,
      ...(command.aliases ?? []),
    ]),
  );
  return [
    ...builtIn,
    // After the built-in rows the prompts and skills follow in name order
    // (R-0401: advisor … anthropic-skills:docs … cowork-plugin-management:…).
    ...custom
      .filter((command) => !reserved.has(command.name))
      .sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
      )
      .map(({ name, description, source, argumentHint }) => ({
        name,
        description,
        source,
        ...(argumentHint ? { argumentHint } : {}),
      })),
  ];
}

/**
 * A bare "/name" followed by whitespace that names exactly one of the listed
 * commands (by name or alias) becomes that command, with the rest of the
 * line as its argument: "/effort high" is /effort with "high".
 */
export function autoResolveSlash(
  previous: string,
  next: string,
  commands: CodeSlashCommand[],
): { command: CodeSlashCommand; rest: string } | undefined {
  const typed = /^\/(\S+)$/.exec(previous)?.[1].toLowerCase();
  if (
    typed === undefined ||
    !next.startsWith(previous) ||
    !/^\s/.test(next.slice(previous.length))
  )
    return undefined;
  const named = commands.filter(
    (command) =>
      command.name.toLowerCase() === typed ||
      command.aliases?.some((alias) => alias.toLowerCase() === typed),
  );
  return named.length === 1
    ? { command: named[0], rest: next.slice(previous.length + 1) }
    : undefined;
}

export function filterCodeSlashCommands(
  query: string,
  commands: CodeSlashCommand[] = codeSlashCommands,
) {
  const search = query.trim().toLowerCase();
  if (!search) return commands.filter((command) => !command.typedOnly);
  // A command is found by its name or an alias, as a part of it, and by
  // nothing else: not its description, not letters picked out in order (live
  // claude.ai bundle, 2026-10-16, shared-5 I$ over c_: label and aliases).
  const rank = (command: CodeSlashCommand) => {
    const name = command.name.toLowerCase();
    if (name === search) return 0;
    // An alias finds its command ("/stats" shows /usage).
    if (command.aliases?.includes(search)) return 0.5;
    if (name.startsWith(search)) return 1;
    if (command.aliases?.some((alias) => alias.startsWith(search))) return 1.5;
    if (name.includes(search)) return 2;
    if (command.aliases?.some((alias) => alias.includes(search))) return 2.5;
    return Infinity;
  };
  return commands
    .map((command, index) => ({ command, index, score: rank(command) }))
    .filter((value) => Number.isFinite(value.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((value) => value.command);
}

export { splitPromptArguments, expandCustomPrompt, skillMessage } from "../../../shared/custom-command-expansion";
