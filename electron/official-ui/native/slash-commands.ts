/** Strict local command inventory and one-shot preparation for owned Code sessions. */
import { z } from "zod";
import {
  expandCustomPrompt,
  skillMessage,
} from "../../../shared/custom-command-expansion";
import type { CustomSlashCommand } from "../../../shared/composer-api";
import type { AdapterContext } from "../api/context";
import { sessionAccountScope } from "./session-account-scope";
import type { SkillReference } from "../../../shared/skill-references";
import { expandSshMarkdownCommand, type SshSlashCommand } from "../../ssh/slash-commands";
// Built-ins keep their existing host meaning; a custom prompt cannot shadow them.
const reserved = new Set([
  "schedule",
  "btw",
  "rewind",
  "fork",
  "mcp",
  "plugin",
  "feedback",
  "model",
  "effort",
  "fast",
  "plan",
  "permissions",
  "skills",
  "output-style",
  "goal",
  "rename",
  "export",
  "add-dir",
  "cd",
  "diff",
  "loop",
  "tasks",
  "workflows",
  "status",
  "usage",
  "usage-credits",
  "autocompact",
  "config",
  "storage",
  "sandbox",
  "theme",
  "resume",
  "login",
  "help",
  "copy",
  "review",
  "handoff",
  "compact",
  "clear",
  "logout",
  "quit",
  "exit",
  "stats",
  "cost",
  "side",
  "ultrareview",
  "subtask",
  "plugins",
  "marketplace",
  "bug",
  "share",
  "allowed-tools",
  "name",
  "bashes",
  "workflow",
  "extra-usage",
  "context",
  "memory",
  "settings",
  "logs",
  "reset-limits",
  "create-pr",
  "auto-mode-setup",
  "send-to-project",
  "continue-in-projects",
  "continue",
  "advisor",
  "reset",
  "new",
]);
export function isReservedCodeSlashCommand(name: string) {
  return reserved.has(name.toLowerCase());
}

const input = z
  .object({
    sessionId: z
      .string()
      .regex(/^local_[A-Za-z0-9_-]{1,500}$/)
      .optional(),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine((v) => !(v.sessionId && v.cwd), "Choose one command scope.");
type CommandScope = z.infer<typeof input>;
export const parseCodeCommandScope = (raw?: unknown) => input.parse(raw ?? {});
const command = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
    description: z.string().max(4096),
    source: z.enum(["prompt", "skill"]),
    argumentHint: z.string().max(4096).optional(),
  })
  .strict();
const catalog = z.object({
  commands: z.array(command).max(2000),
  usageCredits: z.boolean(),
}).strict();

export function codeSlashCatalog(response: unknown) {
  const result = catalog.parse(response);
  if (new Set(result.commands.map(({ name }) => name)).size !== result.commands.length)
    throw Error("Duplicate command names.");
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
    throw Error("The command inventory is too large.");
  return {
    ...result,
    commands: result.commands.filter(({ name }) => !reserved.has(name.toLowerCase())),
  };
}

export function codeSlashInvocation(text: string) {
  const invocation = leadingSlashCommand(text);
  if (invocation && !isReservedCodeSlashCommand(invocation.name)) return invocation;
}

export function codeSlashText(entry: z.infer<typeof command>, args: string, body?: unknown) {
  if (entry.source === "prompt" && (typeof body !== "string" || body.length > 65536))
    throw Error("The selected prompt is no longer available.");
  const text = entry.source === "skill" ? skillMessage(entry.name, args) :
    expandCustomPrompt(typeof body === "string" ? body : "", args);
  return checkedCommandText(text);
}

function checkedCommandText(text: string) {
  if (!text.trim() || text.length > 200000 || Buffer.byteLength(text) > 1024 * 1024)
    throw Error("The expanded command is empty or too large.");
  return text;
}
export function createNativeSlashInventory(
  ctx: AdapterContext,
  mode: "code" | "cowork",
) {
  const scope = sessionAccountScope(ctx, () => {});
  const check = () => {
    scope.sync();
    if (!ctx.account()?.id) throw Error("Sign in to read commands.");
    if (ctx.readOnly || !ctx.localCall)
      throw Error("Local commands are unavailable on this host.");
    if (ctx.isCurrent?.() === false)
      throw Error("The account changed during this request.");
  };
  return (raw?: unknown) =>
    scope.run(async () => {
      const options = parseCodeCommandScope(raw);
      check();
      let args: Record<string, unknown> = { strictSources: true };
      if (options.sessionId) {
        if (!ctx.localLoadConversation)
          throw Error("Local session ownership cannot be checked.");
        const id = options.sessionId.slice(6);
        const conversation = await scope.guard(() =>
          ctx.localLoadConversation!(id),
        );
        check();
        if (
          !conversation ||
          conversation.id !== id ||
          conversation.mode !== mode ||
          conversation.cloudHosted || conversation.cloudEnvironmentId ||
          conversation.incognito ||
          (conversation.environment &&
            conversation.environment.kind !== "local") ||
          (conversation.sessionAuthors &&
            (conversation.sessionAuthors.ownerAccountUuid !== ctx.account()?.id ||
             conversation.sessionAuthors.ownerAccountUuid !==
              conversation.sessionAuthors.viewerAccountUuid))
        )
          throw Error("Local command session not found.");
        args.conversationId = id;
      } else if (options.cwd) {
        // The real listSlashCommands handler must call ctx.allowedFolder before reading
        // this folder. This read is not a grant and does not expand folder trust.
        args.folder = options.cwd;
      }
      const response = await scope.guard(() =>
        ctx.localCall!("listSlashCommands", args),
      );
      check();
      return codeSlashCatalog(response);
    });
}

export function nativeSlashCommandRows(commands: CustomSlashCommand[]) {
  return commands.map(({ name, description, argumentHint }) => ({
    name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    kind: "skill" as const,
  }));
}

export interface PreparedNativeCommand {
  message: string;
  sendText?: string;
  command?: { name: string; source: "prompt" | "skill" };
  skillReferences?: SkillReference[];
}
/** Exact leading-token syntax only. Unknown, escaped and non-leading text remains literal. */
export function leadingSlashCommand(message: string) {
  const match =
    /^\/([A-Za-z0-9_][A-Za-z0-9._:-]{0,63})(?:[ \t]+|\r?\n|$)/.exec(message);
  return match && { name: match[1], args: message.slice(match[0].length) };
}

type SshCommandScope =
  | { kind: "draft"; hostId: string; cwd?: string }
  | { kind: "session"; conversationId: string };

export async function readNativeSshCommands(
  call: (name: string, ...args: unknown[]) => Promise<unknown>,
  target: SshCommandScope,
  names?: string[],
) {
  const list = await call("officialSshSlashCommands", target, names) as
    { commands: SshSlashCommand[]; project?: string } | null;
  if (!list) return null;
  return {
    ...list,
    commands: list.commands.filter(item => !isReservedCodeSlashCommand(item.name)),
  };
}

export async function prepareNativeSshCommand(
  read: (names: string[]) => ReturnType<typeof readNativeSshCommands>,
  message: string,
  references: readonly SkillReference[],
): Promise<PreparedNativeCommand> {
  const leading = codeSlashInvocation(message.trimStart());
  const names = new Set(references.flatMap(reference => reference.kind === "local" ? [reference.name] : []));
  if (leading) names.add(leading.name);
  if (!names.size) return { message };
  const catalog = await read([...names]);
  if (!catalog) return { message };
  const commands = new Map(catalog.commands.map(command => [command.name, command]));
  const command = leading && commands.get(leading.name);
  const selectedPrompts = [...names].flatMap(name => {
    const candidate = commands.get(name);
    return candidate?.source === "prompt" ? [candidate] : [];
  });
  if (!selectedPrompts.length) {
    if (!references.length && leading && command?.source === "skill")
      return { message, sendText: codeSlashText(command, leading.args), command: { name: command.name, source: "skill" } };
    return { message };
  }
  const skillReferences = references.filter(reference =>
    reference.kind !== "local" || commands.get(reference.name)?.source !== "prompt");
  const expanded = selectedPrompts.map(prompt =>
    expandSshMarkdownCommand(prompt, leading?.name === prompt.name ? leading.args : "", catalog.project));
  if (skillReferences.length || !leading || command?.source !== "prompt") expanded.unshift(message);
  return {
    message,
    sendText: checkedCommandText(expanded.join("\n\n")),
    command: { name: selectedPrompts[0].name, source: "prompt" },
    skillReferences,
  };
}

export async function expandNativeSlashCommand(
  command: CustomSlashCommand,
  args: string,
  readPrompt: (name: string) => Promise<unknown>,
) {
  const body = command.source === "prompt" ? await readPrompt(command.name) : undefined;
  return codeSlashText(command, args, body);
}

export async function prepareCoworkSlashPrompt(
  ctx: AdapterContext,
  message: string,
  references: readonly SkillReference[],
  options: CommandScope,
) {
  const [first] = references;
  if (first?.kind !== "local" || message.slice(0, first.start).trim()) return;
  const invocation = codeSlashInvocation(message.trimStart());
  if (invocation?.name !== first.name) return;
  const listed = await createNativeSlashInventory(ctx, "cowork")(options);
  const command = listed.commands.find(item => item.name === first.name && item.source === "prompt");
  if (!command) return;
  if (references.length > 1) throw Error("Send a custom command without additional skill selections.");
  return expandNativeSlashCommand(command, invocation.args, name => ctx.localCall!("readCustomPrompt", name));
}

export function createNativeSlashPreparation(ctx: AdapterContext) {
  const inventory = createNativeSlashInventory(ctx, "code");
  const scope = sessionAccountScope(ctx, () => {});
  return (message: string, options: CommandScope, references: readonly SkillReference[] = []): Promise<PreparedNativeCommand> =>
    scope.run(async () => {
      const first = references[0];
      if (first && (first.kind !== "local" || message.slice(0, first.start).trim())) return { message };
      const invocation = codeSlashInvocation(first ? message.trimStart() : message);
      if (!invocation) return { message };
      if (first && first.name !== invocation.name) return { message };
      const listed = await scope.guard(() => inventory(options));
      const command = listed.commands.find((item) => item.name === invocation.name);
      if (!command || (first && command.source !== "prompt")) return { message };
      if (references.length > 1) throw Error("Send a custom command without additional skill selections.");
      const sendText = await expandNativeSlashCommand(command, invocation.args, (name) => {
        if (!ctx.localCall)
          throw Error("Local command content is unavailable.");
        return scope.guard(() => ctx.localCall!("readCustomPrompt", name));
      });
      scope.sync();
      if (ctx.isCurrent?.() === false || ctx.readOnly)
        throw Error("Local commands are unavailable or the account changed during this request.");
      return {
        message,
        sendText,
        command: { name: command.name, source: command.source },
      };
    });
}
