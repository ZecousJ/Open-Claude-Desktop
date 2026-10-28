import type { KnowledgeFile } from "../../../shared/collections-api";

export type KnowledgeNode =
  | {
      kind: "folder";
      name: string;
      path: string;
      children: KnowledgeNode[];
      fileCount: number;
    }
  | { kind: "file"; name: string; path: string; file: KnowledgeFile };

export function knowledgeFileMatches(file: KnowledgeFile, query: string) {
  return (
    knowledgeMatches(file.name, query) ||
    (file.source?.provider === "gdrive" &&
      knowledgeMatches(file.source.title, query)) ||
    (file.source?.provider === "mcp" &&
      knowledgeMatches(file.source.title || file.source.name, query))
  );
}

// Folder-first natural sorting and filtered expansion.
export function groupKnowledge(files: KnowledgeFile[]): KnowledgeNode[] {
  const root: KnowledgeNode[] = [];
  for (const file of files) {
    const parts = file.name.replace(/\\/g, "/").split("/").filter(Boolean);
    const name = parts.pop() ?? file.name;
    let children = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let folder = children.find(
        (node) => node.kind === "folder" && node.name === part,
      );
      if (!folder || folder.kind !== "folder") {
        folder = {
          kind: "folder",
          name: part,
          path,
          children: [],
          fileCount: 0,
        };
        children.push(folder);
      }
      folder.fileCount += 1;
      children = folder.children;
    }
    children.push({ kind: "file", name, path: file.name, file });
  }
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const sort = (nodes: KnowledgeNode[]) => {
    nodes.sort((first, second) =>
      first.kind === second.kind
        ? collator.compare(first.name, second.name)
        : first.kind === "folder"
          ? -1
          : 1,
    );
    for (const node of nodes) if (node.kind === "folder") sort(node.children);
  };
  sort(root);
  return root;
}

export function knowledgeMatches(name: string, query: string) {
  const parts = query
    .trim()
    .split(/[-_\s]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return (
    !query.trim() ||
    new RegExp(parts.join("[-_\\s]+"), "iu").test(name.normalize("NFKC"))
  );
}

export function knowledgeRows(
  nodes: KnowledgeNode[],
  expanded: Set<string>,
  query = "",
  depth = 0,
): { node: KnowledgeNode; depth: number; expanded?: boolean }[] {
  return nodes.flatMap((node) => {
    if (node.kind === "file")
      return knowledgeMatches(node.path, query) ? [{ node, depth }] : [];
    const open = Boolean(query.trim()) || expanded.has(node.path);
    const children = open
      ? knowledgeRows(node.children, expanded, query, depth + 1)
      : [];
    if (query.trim() && !children.length) return [];
    return [{ node, depth, expanded: open }, ...children];
  });
}

export function selectKnowledge(
  selected: Set<string>,
  name: string,
  scope: string[],
  anchor: string | null,
  range: boolean,
) {
  const next = new Set(selected);
  const start = anchor ? scope.indexOf(anchor) : -1;
  const end = scope.indexOf(name);
  if (range && start >= 0 && end >= 0) {
    for (const item of scope.slice(
      Math.min(start, end),
      Math.max(start, end) + 1,
    ))
      next.add(item);
  } else if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}
