import { customPromptsFolder, listCustomPrompts, readCustomPrompt, slashSkills } from "../../electron/ipc/composer";
import {
  expandNativeSlashCommand,
  isReservedCodeSlashCommand,
  leadingSlashCommand,
} from "../../electron/official-ui/native/slash-commands";
import type { CustomSlashCommand } from "../../shared/composer-api";
import type { SkillReference } from "../../shared/skill-references";
import type { Conversation } from "../../shared/types";
import { officialCodeWorkspaceDirectory } from "./official-code-workspace-files";
import type { WebAppContext } from "./web-app-context";

async function codeCommands(ctx: WebAppContext, conversation: Conversation, cwd: string) {
  const engine = ctx.engineFor(conversation.id);
  const store = ctx.store;
  const prompts = customPromptsFolder(store.root);
  const commands = listCustomPrompts(prompts).filter(({ name }) => !isReservedCodeSlashCommand(name));
  const taken = new Set(commands.map(({ name }) => name));
  const rpc = engine.rpc ?? ctx.engine.rpc;
  if (rpc) {
    const listed = await rpc.call("skills/list", { cwds: [cwd] }).catch(() => null);
    for (const skill of slashSkills(listed?.data))
      if (!taken.has(skill.name) && !isReservedCodeSlashCommand(skill.name)) commands.push(skill);
  }
  return { commands, prompts };
}

export async function prepareOfficialCodeCommand(ctx: WebAppContext, conversation: Conversation, text: string, references: readonly SkillReference[]) {
  const first = references[0];
  if (first && (first.kind !== "local" || text.slice(0, first.start).trim())) return;
  const invocation = leadingSlashCommand(first ? text.trimStart() : text);
  if (!invocation || isReservedCodeSlashCommand(invocation.name)) return;
  if (first && first.name !== invocation.name) return;
  const cwd = officialCodeWorkspaceDirectory(ctx, conversation);
  if (!cwd) return;
  const { commands, prompts } = await codeCommands(ctx, conversation, cwd);
  const command = commands.find(({ name }) => name === invocation.name);
  if (!command || (first && command.source !== "prompt")) return;
  if (references.length > 1) throw Error("Send a custom command without additional skill selections.");
  return expandNativeSlashCommand(command, invocation.args, async (name) => readCustomPrompt(prompts, name));
}

type Command = Pick<CustomSlashCommand, "name" | "description" | "argumentHint">;
type Catalog = {
  rpc: unknown;
  cwd: string;
  expiresAt: number;
  result: Promise<Command[]>;
};
const catalogs = new WeakMap<Conversation, Catalog>();

export function officialCodeCommands(ctx: WebAppContext, conversation: Conversation) {
  const cwd = officialCodeWorkspaceDirectory(ctx, conversation);
  if (!cwd) return;
  const rpc = ctx.engineFor(conversation.id).rpc ?? ctx.engine.rpc;
  const existing = catalogs.get(conversation);
  if (existing && existing.rpc === rpc && existing.cwd === cwd && existing.expiresAt > Date.now())
    return existing.result;
  const result = codeCommands(ctx, conversation, cwd)
    .then(({ commands }) => {
      const compact = conversation.environment?.kind === "space" && conversation.threadId && conversation.turns.length
        ? [{ name: "compact", description: "Compact the conversation context" }]
        : [];
      return [...compact, ...commands.map(({ name, description, argumentHint }) =>
        ({ name, description, ...(argumentHint ? { argumentHint } : {}) }))].slice(0, 200);
    })
    .catch(() => []);
  catalogs.set(conversation, { rpc, cwd, result, expiresAt: Date.now() + 30_000 });
  return result;
}
