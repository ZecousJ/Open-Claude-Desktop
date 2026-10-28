import type { Conversation, Item, Turn } from "./types";

/**
 * The web app's snapshot sends each conversation with its commands' long
 * texts cut (src-web loads over the network; a workspace's command output
 * was 80% of a 1 MB snapshot). A command shows collapsed until opened, and
 * the app loads the conversation's full turns when it opens it
 * (`conversationTurns`), so only what the first screen needs travels first.
 */
export const slimTextLimit = 1024;

function slimItem(item: Item): Item {
  if (item.type !== "commandExecution") return item;
  let cut = false;
  const shorten = <T>(text: T): T => {
    if (typeof text !== "string" || text.length <= slimTextLimit) return text;
    cut = true;
    return `${text.slice(0, slimTextLimit)}…` as T;
  };
  const raw = item as Item & {
    aggregatedOutput?: unknown;
    commandActions?: unknown;
  };
  const slim: Record<string, unknown> = {
    ...item,
    aggregatedOutput: shorten(raw.aggregatedOutput),
    command: shorten(raw.command),
    commandActions: Array.isArray(raw.commandActions)
      ? raw.commandActions.map((action: unknown) =>
          action && typeof action === "object" && "command" in action
            ? {
                ...(action as Record<string, unknown>),
                command: shorten((action as { command: unknown }).command),
              }
            : action,
        )
      : raw.commandActions,
  };
  if (!cut) return item;
  // Fields the item did not have stay absent.
  for (const key of ["aggregatedOutput", "command", "commandActions"])
    if (!(key in item)) delete slim[key];
  return slim as unknown as Item;
}

function slimTurns(turns: Turn[]): { turns: Turn[]; cut: boolean } {
  let any = false;
  const next = turns.map((turn) => {
    const items = turn.items.map(slimItem);
    if (items.every((item, i) => item === turn.items[i])) return turn;
    any = true;
    return { ...turn, items };
  });
  return { turns: any ? next : turns, cut: any };
}

/** The conversation as the web snapshot sends it; `slim` when something was cut. */
export function slimConversation(conversation: Conversation): Conversation {
  const main = slimTurns(conversation.turns);
  let branchesCut = false;
  const savedBranches = conversation.savedBranches?.map((branch) => {
    const slim = slimTurns(branch.turns);
    if (!slim.cut) return branch;
    branchesCut = true;
    return { ...branch, turns: slim.turns };
  });
  if (!main.cut && !branchesCut) return conversation;
  return {
    ...conversation,
    turns: main.turns,
    ...(branchesCut ? { savedBranches } : {}),
    slim: true,
  };
}
