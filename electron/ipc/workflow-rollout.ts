import fs from "node:fs";
import path from "node:path";
import type { Item } from "../../shared/types";
import {
  describedShellTools,
  sanitizeDescription,
} from "../../shared/tool-description";
import { summarizeAgentThread } from "../conversations/agent-transcript";
import {
  applyToolDescriptions,
  toolDescriptionsOf,
} from "../engine/tool-description-store";

import type { Context } from "./workflow";

/** A path strictly inside `folder`. */
function inside(folder: string, file: string) {
  const relative = path.relative(folder, file);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

const sessionFolders = ["sessions", "archived_sessions"];

/**
 * The child's rollout file, when `thread/read` names a plausible one: an
 * absolute `rollout-*.jsonl` in Codex's `sessions/` or `archived_sessions/`.
 * With `codexHome` (the engine's CODEX_HOME), the file, links resolved, must
 * be in that home's session folders.
 */
async function rolloutPath(
  thread: any,
  codexHome?: string,
): Promise<string | undefined> {
  const file = thread?.path;
  if (typeof file !== "string" || !path.isAbsolute(file)) return;
  if (!/^rollout-[^/\\]*\.jsonl$/.test(path.basename(file))) return;
  const normal = path.normalize(file);
  if (!codexHome) {
    const folders = normal.split(path.sep);
    return sessionFolders.some((folder) => folders.includes(folder))
      ? normal
      : undefined;
  }
  try {
    const [home, real] = await Promise.all([
      fs.promises.realpath(codexHome),
      fs.promises.realpath(normal),
    ]);
    return sessionFolders.some((folder) =>
      inside(path.join(home, folder), real),
    )
      ? real
      : undefined;
  } catch {
    return;
  }
}

function shellCommandText(name: string, args: any): string | undefined {
  if (name === "exec_command")
    return typeof args?.cmd === "string" ? args.cmd : undefined;
  if (name === "shell_command")
    return typeof args?.command === "string" ? args.command : undefined;
  if (name === "shell" && Array.isArray(args?.command))
    return args.command
      .filter((part: unknown) => typeof part === "string")
      .join(" ");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output))
    return output
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  return "";
}

/** Exit code and output of a shell call's result, as Codex words it. */
function shellResult(text: string) {
  const code =
    /^Process exited with code (-?\d+)$/m.exec(text)?.[1] ??
    /^Exit code: (-?\d+)$/m.exec(text)?.[1];
  const marker = text.indexOf("\nOutput:\n");
  return {
    exitCode: code === undefined ? undefined : Number(code),
    output: marker < 0 ? text : text.slice(marker + "\nOutput:\n".length),
    running: /^Process running with session ID /m.test(text),
  };
}

/**
 * Codex 0.144.1 keeps no command items in a thread's history, so
 * `thread/read` of a child agent lists only its messages. The rollout file
 * it names still holds the model's shell calls (with the description the
 * gateway asked for, R7) and their results: rebuild the command items from
 * it, in place among the turn's messages. Nothing changes when Codex already
 * reported command items or the rollout is missing or too large.
 */
interface RebuiltCall {
  turnId?: string;
  /** How many of the turn's messages came before the call. */
  afterMessages: number;
  item: Item;
}

/** Parsed rollouts, by file, while their size and mtime are unchanged. */
const rolloutCache = new Map<
  string,
  { size: number; mtimeMs: number; calls: RebuiltCall[] }
>();

const maxCachedRollouts = 64;

/** The shell calls (and their results) a rollout records. */
function parseRollout(text: string): RebuiltCall[] {
  const calls = new Map<string, RebuiltCall>();
  const messagesSeen = new Map<string | undefined, number>();
  let turnId: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (
      (entry.type === "event_msg" && payload.type === "task_started") ||
      entry.type === "turn_context"
    ) {
      if (typeof payload.turn_id === "string") turnId = payload.turn_id;
      continue;
    }
    if (entry.type === "event_msg" && payload.type === "agent_message") {
      messagesSeen.set(turnId, (messagesSeen.get(turnId) ?? 0) + 1);
      continue;
    }
    if (entry.type !== "response_item") continue;
    const owner =
      typeof payload.internal_chat_message_metadata_passthrough?.turn_id ===
      "string"
        ? payload.internal_chat_message_metadata_passthrough.turn_id
        : turnId;
    const callId = payload.call_id;
    if (typeof callId !== "string" || !callId || callId.length > 500) continue;
    if (
      payload.type === "function_call" &&
      describedShellTools.has(payload.name) &&
      calls.size < maxRebuiltCommands &&
      !calls.has(callId)
    ) {
      let args: any;
      try {
        args = JSON.parse(String(payload.arguments ?? ""));
      } catch {
        args = undefined;
      }
      const command = shellCommandText(payload.name, args);
      const description = sanitizeDescription(args?.description);
      calls.set(callId, {
        turnId: owner,
        afterMessages: messagesSeen.get(owner) ?? 0,
        item: {
          id: callId,
          type: "commandExecution",
          command: command?.slice(0, 5000) ?? "",
          ...(description ? { description } : {}),
          status: "inProgress",
        },
      });
    } else if (payload.type === "function_call_output" && calls.has(callId)) {
      const { item } = calls.get(callId)!;
      const result = shellResult(outputText(payload.output));
      item.aggregatedOutput = result.output.slice(-50_000);
      if (result.exitCode !== undefined) {
        item.exitCode = result.exitCode;
        item.status = result.exitCode === 0 ? "completed" : "failed";
      } else if (!result.running) item.status = "completed";
    }
  }
  return [...calls.values()];
}

/** A rollout's shell calls, parsed again only when the file changed. */
async function rolloutCalls(file: string): Promise<RebuiltCall[] | undefined> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > maxRolloutBytes) return;
    const cached = rolloutCache.get(file);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      rolloutCache.delete(file);
      rolloutCache.set(file, cached);
      return cached.calls;
    }
    const calls = parseRollout(await fs.promises.readFile(file, "utf8"));
    rolloutCache.delete(file);
    rolloutCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, calls });
    while (rolloutCache.size > maxCachedRollouts)
      rolloutCache.delete(rolloutCache.keys().next().value!);
    return calls;
  } catch {
    return;
  }
}

/**
 * Codex 0.144.1 keeps no command items in a thread's history, so
 * `thread/read` of a child agent lists only its messages. The rollout file
 * it names still holds the model's shell calls (with the description the
 * gateway asked for, R7) and their results: rebuild the command items from
 * it, in place among the turn's messages. Nothing changes when Codex already
 * reported command items or the rollout is missing, outside `codexHome`'s
 * session folders (when given) or too large.
 */
export async function rebuildChildCommands(
  thread: any,
  codexHome?: string,
): Promise<number> {
  const turns: any[] = Array.isArray(thread?.turns) ? thread.turns : [];
  if (
    !turns.length ||
    turns.some(
      (turn) =>
        Array.isArray(turn?.items) &&
        turn.items.some((item: any) => item?.type === "commandExecution"),
    )
  )
    return 0;
  const file = await rolloutPath(thread, codexHome);
  if (!file) return 0;
  const parsed = await rolloutCalls(file);
  if (!parsed?.length) return 0;
  // The cached calls stay as parsed; each read gets its own items.
  const calls = parsed.map((call) => ({
    ...call,
    item: structuredClone(call.item),
  }));
  let rebuilt = 0;
  turns.forEach((turn, index) => {
    const own = calls.filter((call) =>
      call.turnId === undefined
        ? index === turns.length - 1
        : call.turnId === turn?.id,
    );
    if (!own.length || !Array.isArray(turn.items)) return;
    const ended = turn.status !== "inProgress";
    for (const { item } of own) {
      // A call whose result never came ended with its turn.
      if (ended && item.status === "inProgress") item.status = "completed";
      item.lifecycleStatus =
        item.status === "inProgress"
          ? "inProgress"
          : turn.status === "interrupted"
            ? "interrupted"
            : item.status === "failed"
              ? "failed"
              : "completed";
    }
    // A call made after the model's n-th message goes before its next one.
    const items: Item[] = [];
    const placed = new Set<string>();
    let messages = 0;
    const place = (upTo: number) => {
      for (const call of own)
        if (!placed.has(call.item.id) && call.afterMessages <= upTo) {
          placed.add(call.item.id);
          items.push(call.item);
        }
    };
    for (const item of turn.items) {
      if (item?.type === "agentMessage") {
        place(messages);
        messages++;
      }
      items.push(item);
    }
    place(Number.POSITIVE_INFINITY);
    rebuilt += own.length;
    turn.items = items;
  });
  return rebuilt;
}

/** A child thread read from Codex, with its commands and their descriptions (R7). */
export async function describeChildThread(context: Context, thread: any) {
  // Codex runs with CODEX_HOME in the profile (engine.ts).
  await rebuildChildCommands(
    thread,
    path.join(context.store.root, "codex-home"),
  );
  applyToolDescriptions(thread, toolDescriptionsOf(context.engine));
}

/**
 * The child's tool count and current action. A running command the model
 * described shows its description (R7: the imperative sentence while it
 * runs) instead of "Running a command".
 */
export function describeActivity(thread: any) {
  const activity = summarizeAgentThread(thread);
  if (activity.currentAction !== "Running a command") return activity;
  const running = (Array.isArray(thread?.turns) ? thread.turns : [])
    .flatMap((turn: any) => (Array.isArray(turn?.items) ? turn.items : []))
    .reverse()
    .find(
      (item: any) =>
        item?.type === "commandExecution" &&
        ["inProgress", "running"].includes(
          item.status ?? item.lifecycleStatus ?? "",
        ),
    );
  return typeof running?.description === "string"
    ? { ...activity, currentAction: running.description as string }
    : activity;
}

/** Largest child rollout read to rebuild its commands. */
export const maxRolloutBytes = 16 * 1024 * 1024;

/** Most commands rebuilt for one child thread. */
export const maxRebuiltCommands = 500;
