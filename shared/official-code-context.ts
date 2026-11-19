import type { Conversation } from "./types";
import "./agent-api";

export function parseCodeAutoCompact(value: string): number | undefined {
  const setting = value.trim().toLowerCase();
  if (setting === "auto") return 0;
  const count = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(setting.replace(/,/g, ""));
  if (!count) return undefined;
  const units = count[2] === "m" ? 1_000_000 : count[2] === "k" ? 1_000 : 1;
  const tokens = Math.round(Number(count[1]) * units);
  return tokens >= 1_000 && tokens <= 100_000_000 ? tokens : undefined;
}

export function officialContextUsage({ model, tokenUsage }: Pick<Conversation, "model" | "tokenUsage">) {
  const limit = tokenUsage?.modelContextWindow;
  const total = tokenUsage?.last?.totalTokens;
  if (
    (tokenUsage?.model !== undefined && tokenUsage.model !== model) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 ||
    typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
  ) return null;

  return {
    model,
    totalTokens: total,
    rawMaxTokens: limit,
    percentage: Math.round((total / limit) * 100),
    detail: "summary" as const,
    categories: [
      { name: "Context", kind: "used" as const, tokens: total },
      { name: "Free space", kind: "free" as const, tokens: Math.max(0, limit - total) },
    ],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  };
}
