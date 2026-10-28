import type { Conversation, Item, Turn } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { fileChangeDiff, type DiffFile } from "../diff/diff-model";

/**
 * A conversation's own record of what it changed. Every applied file change of
 * a turn carries its diff; a turn's changes are those, and "All changes" is
 * every turn's in order.
 */
export interface TurnChanges {
  turnId: string;
  /** The person's message that started the turn. */
  prompt: string;
  createdAt: number;
  files: DiffFile[];
  additions: number;
  deletions: number;
}

/** A file change that was written (not running, failed, declined or stopped). */
function applied(item: Item) {
  return (
    item.type === "fileChange" &&
    !itemIsRunning(item) &&
    item.status !== "failed" &&
    item.status !== "declined" &&
    item.lifecycleStatus !== "failed" &&
    item.lifecycleStatus !== "interrupted"
  );
}

export function turnFiles(turn: Turn): DiffFile[] {
  return turn.items
    .filter(applied)
    .flatMap((item) => (item.changes ?? []).map(fileChangeDiff))
    .filter((file) => file.path);
}

/** The turns that changed files, oldest first. */
export function conversationTurnChanges(
  conversation: Conversation,
): TurnChanges[] {
  return conversation.turns.flatMap((turn) => {
    const files = turnFiles(turn);
    if (!files.length) return [];
    return [
      {
        turnId: turn.id,
        prompt: turn.prompt ?? "",
        createdAt: turn.createdAt,
        files,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
    ];
  });
}

/** A folder or file of the changed-files tree. */
export interface TreeNode {
  name: string;
  /** The file's path; "" for a folder. */
  path: string;
  additions: number;
  deletions: number;
  children: TreeNode[];
}

const slashes = (value: string) =>
  value.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The folder the tree starts at: the conversation's folder, or else the
 * profile's own workspace a chat without a folder works in.
 */
export function changesRoot(files: DiffFile[], cwd?: string) {
  if (cwd) return slashes(cwd);
  for (const file of files) {
    const match = /^(.*\/profiles\/[^/]+\/workspace)\//.exec(
      slashes(file.path),
    );
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The changed files as one flat list by path ("Group files by folder" off);
 * a name reads from `folder` down as in the tree.
 */
export function changedFileList(
  files: DiffFile[],
  folder?: string,
): TreeNode[] {
  return files
    .map((file) => {
      const full = slashes(file.path);
      const inside = folder && full.startsWith(`${folder}/`);
      return {
        name: inside ? full.slice(folder.length + 1) : full,
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        children: [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The changed files as a tree of folders, folders first then files, each
 * by name; a folder's counts are its files'. A file changed several times
 * counts every change. Under `folder` a file reads from that folder down; a
 * file outside it keeps its whole path.
 */
export function changedFileTree(
  files: DiffFile[],
  folder?: string,
): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    additions: 0,
    deletions: 0,
    children: [],
  };
  for (const file of files) {
    const full = slashes(file.path);
    const inside = folder && full.startsWith(`${folder}/`);
    const parts = (inside ? full.slice(folder.length + 1) : full)
      .split("/")
      .filter(Boolean);
    let node = root;
    node.additions += file.additions;
    node.deletions += file.deletions;
    parts.forEach((part, index) => {
      const leaf = index === parts.length - 1;
      let child = node.children.find(
        (c) => c.name === part && (leaf ? c.path === file.path : !c.path),
      );
      if (!child) {
        child = {
          name: part,
          path: leaf ? file.path : "",
          additions: 0,
          deletions: 0,
          children: [],
        };
        node.children.push(child);
      }
      child.additions += file.additions;
      child.deletions += file.deletions;
      node = child;
    });
  }
  const sort = (node: TreeNode) => {
    node.children.sort(
      (a, b) =>
        Number(Boolean(a.path)) - Number(Boolean(b.path)) ||
        a.name.localeCompare(b.name),
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}
