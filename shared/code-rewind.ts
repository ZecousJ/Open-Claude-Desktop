import type { Turn } from "./types";

declare module "./types" {
  interface Conversation {
    codeFilesRewoundTo?: CodeRewindTarget;
  }
  interface Turn {
    refusedPrompt?: { model: string };
  }
  interface ConversationRewind {
    model?: string;
    partial?: true;
    filesRewoundTo?: CodeRewindTarget;
  }
}

export function rewindModel(turns: readonly Turn[], current: string) {
  return (
    turns.find((turn) => turn.refusedPrompt)?.refusedPrompt?.model ?? current
  );
}

declare module "./types" {
  interface ConversationBranch {
    rewindMark?: {
      forkPoint: string;
      direction: "back" | "forward";
      at: number;
    };
  }
}

export function pendingCodeRewindMark(c: import("./types").Conversation) {
  const saved = c.rewind;
  if (!saved) return undefined;
  return {
    id: `rewind-${saved.at}-${saved.index}`,
    forkPoint: c.turns[saved.index - 1]?.id ?? "start",
    direction:
      saved.variant === "pending" ? ("forward" as const) : ("back" as const),
    at: saved.at,
  };
}

export function retireCodeRewind(c: import("./types").Conversation) {
  const saved = c.rewind,
    mark = pendingCodeRewindMark(c);
  if (saved && mark && c.mode === "code") {
    const { id, ...rewindMark } = mark;
    c.savedBranches = [
      ...(c.savedBranches ?? []),
      {
        id,
        threadId: saved.threadId,
        providerId: c.providerId,
        model: saved.model ?? c.model,
        turns: [...c.turns.slice(0, saved.index), ...saved.turns],
        visited: saved.at,
        rewindMark,
      },
    ];
  }
  delete c.rewind;
}

export type CodeRewindTarget = string | { turnId: string; itemId: string };
