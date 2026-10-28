import { ChevronDown, ChevronRight } from "../ui/glyphs";
import { FileGlyph } from "./ChangedFileSection";
import { type TreeNode } from "./turn-changes";

/** The changed-files tree: folders fold, a file opens its diff. */
export function TreeRows({
  nodes,
  depth,
  prefix,
  folded,
  selected,
  onFold,
  onOpen,
  onMenu,
}: {
  nodes: TreeNode[];
  depth: number;
  prefix: string;
  folded: Set<string>;
  selected?: string;
  onFold: (id: string) => void;
  onOpen: (path: string) => void;
  onMenu?: (path: string, event: React.MouseEvent) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const id = `${prefix}/${node.name}`;
        const indent = { paddingLeft: 6 + depth * 12 };
        if (node.path)
          return (
            <button
              key={id}
              className="changes-file-row"
              style={indent}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={selected === node.path}
              tabIndex={-1}
              data-tree-row=""
              aria-current={selected === node.path || undefined}
              title={node.path}
              onClick={() => onOpen(node.path)}
              onContextMenu={(event) => onMenu?.(node.path, event)}
            >
              <FileGlyph />
              <span className="changes-file-name" data-no-translate>
                {node.name}
              </span>
              <span className="changes-stat">
                <span className="changes-add">+{node.additions}</span>
                <span className="changes-del">−{node.deletions}</span>
              </span>
            </button>
          );
        const open = !folded.has(id);
        return (
          <div key={id}>
            <button
              className="changes-file-row changes-folder-row"
              style={indent}
              role="treeitem"
              aria-level={depth + 1}
              tabIndex={-1}
              data-tree-row=""
              aria-expanded={open}
              onClick={() => onFold(id)}
            >
              {open ? (
                <ChevronDown size={14} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={14} strokeWidth={1.75} />
              )}
              <span className="changes-file-name" data-no-translate>
                {node.name}
              </span>
            </button>
            {open && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                prefix={id}
                folded={folded}
                selected={selected}
                onFold={onFold}
                onOpen={onOpen}
                onMenu={onMenu}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
