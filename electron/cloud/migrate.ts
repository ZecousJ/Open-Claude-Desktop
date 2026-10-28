/**
 * Moves the desktop's own Chat and Cowork conversations to the cloud
 * (docs/cloud-sync.md P5), once sync is on and the cloud answers. Each goes
 * with its project and the Codex rollouts of its threads, so it continues in
 * the cloud with its context (shared/cloud-sync-api.ts). Oldest first, so
 * the newest ends on top of the cloud's list.
 *
 * Nothing local is deleted: the cloud copy has the same id, and the merged
 * list shows it once, from the cloud. A moved conversation is written down
 * (`cloud-moved.json` in the profile), so one deleted on the web later does
 * not come back from this computer. One that fails is tried again at the
 * next start.
 */
import fs from "node:fs";
import path from "node:path";
import {
  maxRolloutBytes,
  rolloutNamePattern,
  type ConversationImport,
  type ConversationImported,
  type RolloutFile,
} from "../../shared/cloud-sync-api";
import type { Conversation, Project } from "../../shared/types";

export interface MoveDeps {
  /** The local profile's conversations, projects and folder. */
  store: { root: string; conversations: Conversation[]; projects: Project[] };
  call(
    method: "importConversation",
    args: [ConversationImport],
  ): Promise<unknown>;
  /** Whether the cloud already lists the conversation. */
  inCloud(id: string): boolean;
}

export const movedFile = "cloud-moved.json";

function readMoved(root: string): Set<string> {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(root, movedFile), "utf8"),
    );
    return new Set(
      Array.isArray(value) ? value.filter((v) => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeMoved(root: string, moved: Set<string>) {
  const file = path.join(root, movedFile);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...moved]), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The rollout files of the profile's codex-home, by thread id. */
function rolloutsByThread(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (folder: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (entry.isFile()) {
        const match = entry.name.match(rolloutNamePattern);
        if (match) found.set(match[4], file);
      }
    }
  };
  walk(path.join(root, "codex-home", "sessions"), 0);
  return found;
}

/** Which conversations still move: Chat and Cowork, saved, idle, not moved. */
export function conversationsToMove(
  deps: Pick<MoveDeps, "store" | "inCloud">,
  moved = readMoved(deps.store.root),
) {
  return deps.store.conversations
    .filter(
      (c) =>
        (c.mode === "chat" || c.mode === "cowork") &&
        !c.incognito &&
        !c.linkedToComputer &&
        !c.deviceChatOrigin &&
        c.turns.length > 0 &&
        !c.turns.some((t) => t.status === "inProgress") &&
        !moved.has(c.id) &&
        !deps.inCloud(c.id),
    )
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export async function moveToCloud(deps: MoveDeps) {
  const root = deps.store.root;
  const moved = readMoved(root);
  const pending = conversationsToMove(deps, moved);
  if (!pending.length) return { moved: 0, failed: 0 };
  const rollouts = rolloutsByThread(root);
  let count = 0;
  let failed = 0;
  for (const conversation of pending) {
    const threads = [
      conversation.threadId,
      ...(conversation.savedBranches ?? []).map((b) => b.threadId),
    ].filter((id): id is string => !!id);
    const files: RolloutFile[] = [];
    for (const thread of new Set(threads)) {
      const file = rollouts.get(thread);
      if (!file) continue;
      try {
        if (fs.statSync(file).size > maxRolloutBytes) continue;
        files.push({
          name: path.basename(file),
          data: new Uint8Array(fs.readFileSync(file)),
        });
      } catch {
        // A history that cannot be read: the conversation moves without it.
      }
    }
    const project = deps.store.projects.find(
      (p) => p.id === conversation.projectId,
    );
    try {
      const answer = (await deps.call("importConversation", [
        {
          conversation: new TextEncoder().encode(JSON.stringify(conversation)),
          ...(project
            ? {
                project: {
                  id: project.id,
                  name: project.name,
                  description: project.description,
                  instructions: project.instructions,
                  createdAt: project.createdAt,
                },
              }
            : {}),
          rollouts: files,
        },
      ])) as ConversationImported;
      if (answer?.id !== conversation.id) throw new Error("Unexpected answer.");
      moved.add(conversation.id);
      writeMoved(root, moved);
      count++;
    } catch (error) {
      failed++;
      console.error(
        "Moving a conversation to the cloud:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { moved: count, failed };
}
