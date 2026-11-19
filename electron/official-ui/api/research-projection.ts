import { createHash } from "node:crypto";
import type { Conversation, Turn } from "../../../shared/types";
import { researchFinished, sourceKey, turnSourceUrls } from "../../../shared/research";

export const RESEARCH_ADVANCED = 2;
/** The original toggle only produces off/advanced. LIGHT is a different unsupported mode. */
export const supportedResearchMode = (value: unknown) => value === undefined || value === 0 || value === RESEARCH_ADVANCED;
const phases = {
  starting: [1, "starting"], planning: [2, "planning"], gathering: [3, "searching"],
  writing: [4, "creating_artifact"], done: [5, "completed"], failed: [6, "failed"],
  interrupted: [7, "cancelled"],
} as const;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
export function researchOpaqueId(parts: unknown[]) {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function researchTaskId(org: string, conversation: Conversation, turn: Turn): string | undefined {
  const r = turn.research;
  if (!org || conversation.mode !== "chat" || conversation.incognito || !conversation.id || !turn.id ||
      turn.id.startsWith("pending-") || !r || !Object.hasOwn(phases, r.state) ||
      !time(conversation.createdAt) || !time(turn.createdAt) || !time(r.startedAt) ||
      !Number.isSafeInteger(r.sourceCount) || r.sourceCount < 0 || r.sourceCount > 1_000_000) return;
  return researchOpaqueId(["research-task-v1", org, conversation.id, conversation.createdAt, turn.id, turn.createdAt]);
}
export function researchTask(org: string, c: Conversation, taskId: unknown) {
  if (typeof taskId !== "string" || !/^[0-9a-f-]{36}$/.test(taskId) ||
      c.turns.length > 10_000 || (c.savedBranches?.length ?? 0) > 199 ||
      (c.savedBranches ?? []).reduce((n, b) => n + b.turns.length, c.turns.length) > 10_000) return;
  const found = [...(c.savedBranches ?? []).flatMap(b => b.turns), ...c.turns]
    .filter(t => researchTaskId(org, c, t) === taskId);
  if (!found.length) return;
  // Shared branch prefixes may repeat one stored turn. Conflicting snapshots are ambiguous.
  const first = found[0];
  const sameIdentity = [...(c.savedBranches ?? []).flatMap(b => b.turns), ...c.turns]
    .filter(t => t.id === first.id && t.createdAt === first.createdAt);
  if (sameIdentity.some(t => researchTaskId(org, c, t) !== taskId ||
      JSON.stringify(t.research) !== JSON.stringify(first.research) || t.status !== first.status)) return;
  return c.turns.find(t => found.includes(t)) ?? first;
}
export function researchStatus(turn: Turn) {
  const r = turn.research!;
  const sources = new Map<string, { url: string; title: string; subtitles?: string[] }>();
  const add = (url: unknown, title?: unknown, snippet?: unknown) => {
    const key = typeof url === "string" ? sourceKey(url) : undefined;
    if (!key || sources.has(key) || sources.size >= 1000) return;
    sources.set(key, {
      url: key,
      title: typeof title === "string" && title.trim() ? title.slice(0, 500) : key,
      ...(typeof snippet === "string" && snippet.trim() ? { subtitles: [snippet.slice(0, 2000)] } : {}),
    });
  };
  for (const item of turn.items) {
    if (Array.isArray(item.sources)) for (const source of item.sources) add(source?.url, source?.title, source?.snippet);
    if (Array.isArray(item.citations)) for (const citation of item.citations) add(citation?.url, citation?.title);
    if (Array.isArray(item.webCitations)) for (const url of item.webCitations) add(url);
  }
  const toolCalls = sources.size ? [{ tool_name: "web_search", message: "Sources", output: { type: "rich_content", content: [...sources.values()] } }] : [];
  const snippets = r.plan || toolCalls.length ? [{
    thinking_blocks: r.plan ? [{ thinking: r.plan }] : [],
    tool_calls: toolCalls,
    complete: researchFinished(r),
  }] : [];
  return {
    status: phases[r.state][1],
    // Same root-task view as original Aa(servedResearch), not a subagent roster.
    agents: r.title || snippets.length ? [{ name: r.title?.slice(0, 200) ?? "", annotated_snippets: snippets,
      started_at: new Date(r.startedAt).toISOString(),
      completed_at: time(r.completedAt) ? new Date(r.completedAt).toISOString() : null,
      total_sources: r.sourceCount }] : [],
    started_at: new Date(r.startedAt).toISOString(),
    finished_at: time(r.completedAt) ? new Date(r.completedAt).toISOString() : null,
    total_sources: r.sourceCount,
    ...(r.title ? { headline: r.title.slice(0, 200) } : {}),
    error: r.error ?? null,
    ...(r.errorModel ? { error_model: r.errorModel } : {}),
  };
}
export function researchBlock(org: string, c: Conversation, turn: Turn, groupId: string, timestamp: (n: number | undefined) => unknown) {
  const taskId = researchTaskId(org, c, turn);
  if (!taskId) return;
  const r = turn.research!;
  const domains = new Map<string, number>();
  for (const url of turnSourceUrls(turn)) {
    const host = new URL(url).hostname;
    domains.set(host, (domains.get(host) ?? 0) + 1);
  }
  return {
    id: `${taskId}:research`, displayGroupId: groupId,
    // This is the completed launch receipt, not the still-running research task.
    isComplete: true, state: 2, toolDisplayName: "Research", text: "",
    displayContent: { content: { case: "research", value: {
      taskId, status: phases[r.state][0], headline: r.title?.slice(0, 200) ?? "",
      totalSources: r.sourceCount, agents: [], startedAt: timestamp(r.startedAt),
      ...(time(r.completedAt) ? { completedAt: timestamp(r.completedAt), finishedAt: timestamp(r.completedAt) } : {}),
      topSourceDomains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => ({ name })),
    } } },
  };
}
