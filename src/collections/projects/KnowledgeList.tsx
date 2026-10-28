import { OverflowText } from "../../ui/OverflowText";
import { formatText, t } from "../../i18n";
import { useRef, useState, type MouseEvent } from "react";
import type { ProjectCapabilities } from "../../../shared/project-access";
import type {
  PendingKnowledgeFile,
  KnowledgeUploadCapabilities,
} from "../../../shared/project-knowledge-pending";
import { knowledgeDocumentExtensions } from "../../../shared/project-knowledge-encoding";
import {
  File as FileGlyph,
  FileSpreadsheet,
  FolderOpen,
  Link,
  RefreshCw,
  MoreVertical,
  ChevronDown,
  ChevronRight,
  Folder,
  Trash2,
  X,
  TriangleAlert,
} from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { PageMenu } from "../PageMenu";
import {
  type KnowledgeFile,
  type ProjectKnowledge as Knowledge,
} from "../../../shared/collections-api";
import {
  groupKnowledge,
  knowledgeFileMatches,
  knowledgeRows,
} from "./knowledge-tree";
import "./knowledge-list.css";

export type KnowledgeSnapshot = Knowledge & {
  capabilities?: ProjectCapabilities;
  pending?: PendingKnowledgeFile[];
  uploadCapabilities?: KnowledgeUploadCapabilities;
};

// File rows and picking.
export function KnowledgeList({
  files,
  pending = [],
  query = "",
  selected: requestedSelected,
  busy,
  onPick,
  onRemove,
  onSync,
  syncing,
  onOpen,
  viewing,
  compact = false,
  readOnly = false,
  waiting = [],
  onReadPending,
  onRemovePending,
}: {
  files: KnowledgeFile[];
  readOnly?: boolean;
  waiting?: PendingKnowledgeFile[];
  onReadPending?: (file: PendingKnowledgeFile) => void;
  onRemovePending?: (file: PendingKnowledgeFile) => void;
  pending?: KnowledgeFile[];
  query?: string;
  selected?: Set<string>;
  busy: boolean;
  onPick: (name: string, range: boolean, scope?: string[]) => void;
  onRemove: (name: string) => void;
  onSync?: (name: string) => void;
  syncing?: string;
  onOpen?: (file: KnowledgeFile, anchor?: HTMLButtonElement) => void;
  viewing?: string;
  compact?: boolean;
}) {
  const selected = readOnly ? undefined : requestedSelected;
  const [expanded, setExpanded] = useState(new Set<string>());
  const sources = files.filter(
    (file) => file.source && knowledgeFileMatches(file, query),
  );
  const rows = knowledgeRows(
    groupKnowledge(files.filter((file) => !file.source)),
    expanded,
    query,
  );
  const scope = [
    ...sources.map((file) => file.name),
    ...rows.flatMap(({ node }) => (node.kind === "file" ? [node.path] : [])),
  ];
  const toggle = (path: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="prj-context-list">
      {pending.map((file, index) => (
        <div
          className="prj-context-row"
          key={`pending-${index}`}
          aria-busy="true"
        >
          <Spinner inheritColor size={20} className="spin" />
          <span className="prj-context-name" data-no-translate>
            {file.name}
          </span>
          <small>Uploading...</small>
        </div>
      ))}
      {waiting.map((file) => (
        <div
          key={`waiting-${file.id}`}
          className="prj-context-row prj-context-pending-choice"
          aria-busy={file.status === "extracting" || undefined}
        >
          {file.status === "extracting" ? (
            <Spinner inheritColor size={20} className="spin" />
          ) : (
            <TriangleAlert size={20} aria-hidden="true" />
          )}
          <span className="prj-context-name" data-no-translate>
            {file.name}
          </span>
          {file.status === "extracting" && <small>{t("Uploading...")}</small>}
          {!readOnly && file.status !== "extracting" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onReadPending?.(file)}
            >
              {t(
                (knowledgeDocumentExtensions as readonly string[]).includes(
                  file.name.split(".").pop()?.toLowerCase() ?? "",
                )
                  ? "Retry"
                  : "Choose how to read this file",
              )}
            </button>
          )}
          {!readOnly && file.status !== "extracting" && (
            <button
              type="button"
              disabled={busy}
              aria-label={formatText("Remove {name}", { name: file.name })}
              onClick={() => onRemovePending?.(file)}
            >
              <X size={14} />
            </button>
          )}
          {file.error && <small role="alert">{t(file.error)}</small>}
        </div>
      ))}
      {sources.map((file) => (
        <KnowledgeRow
          key={file.name}
          file={file}
          name={
            file.source?.provider === "gdrive"
              ? file.source.title
              : file.source?.provider === "mcp"
                ? file.source.title || file.source.name
                : file.name
          }
          depth={0}
          selected={selected}
          busy={busy}
          syncing={syncing === file.name}
          onSync={onSync}
          onPick={(name, range) => onPick(name, range, scope)}
          onRemove={onRemove}
          onOpen={onOpen}
          viewing={viewing}
          compact={compact}
          readOnly={readOnly}
        />
      ))}
      {rows.map(({ node, depth, expanded: open }) =>
        node.kind === "folder" ? (
          <div
            className="prj-context-row"
            key={`folder-${node.path}`}
            style={{ paddingInlineStart: 12 + depth * 20 }}
          >
            {open ? <FolderOpen size={20} /> : <Folder size={20} />}
            {!query.trim() && (
              <button
                type="button"
                className="prj-context-open"
                aria-label={formatText("Open folder {name}", {
                  name: node.name.replace(/(?<=\p{L})[-_]+(?=\p{L})/gu, " "),
                })}
                aria-expanded={open}
                onClick={() => toggle(node.path)}
              />
            )}
            <span className="prj-context-name" data-no-translate>
              {node.name}
            </span>
            <small>
              {node.fileCount === 1
                ? t("1 item")
                : formatText("{count} items", { count: node.fileCount })}
            </small>
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
        ) : (
          <KnowledgeRow
            key={node.path}
            file={node.file}
            name={node.name}
            depth={depth}
            selected={selected}
            busy={busy}
            onPick={(name, range) => onPick(name, range, scope)}
            onRemove={onRemove}
            onOpen={onOpen}
            viewing={viewing}
            compact={compact}
            readOnly={readOnly}
            onSync={onSync}
            syncing={syncing === node.path}
          />
        ),
      )}
      {!rows.length && !sources.length && query.trim() && (
        <p className="prj-context-no-matches">No matching files.</p>
      )}
    </div>
  );
}

function KnowledgeRow({
  file,
  name,
  depth,
  selected,
  busy,
  onPick,
  onRemove,
  onSync,
  syncing,
  onOpen,
  viewing,
  compact,
  readOnly = false,
}: {
  file: KnowledgeFile;
  readOnly?: boolean;
  name: string;
  depth: number;
  selected?: Set<string>;
  busy: boolean;
  onPick: (name: string, range: boolean) => void;
  onRemove: (name: string) => void;
  onSync?: (name: string) => void;
  syncing?: boolean;
  onOpen?: (file: KnowledgeFile, anchor?: HTMLButtonElement) => void;
  viewing?: string;
  compact?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const label = formatText("More options for {label}", { label: name });
  return (
    <div
      className="prj-context-row"
      data-selected={selected?.has(file.name) || undefined}
      data-viewing={viewing === file.name || undefined}
      style={{ paddingInlineStart: 12 + depth * 20 }}
    >
      {file.source ? (
        <Link size={20} />
      ) : /\.(csv|tsv)$/i.test(file.name) ? (
        <FileSpreadsheet size={20} />
      ) : (
        <FileGlyph size={20} />
      )}
      {(selected || onOpen) && (
        <button
          type="button"
          className="prj-context-open"
          aria-label={name}
          aria-pressed={
            selected
              ? selected.has(file.name)
              : viewing === file.name || undefined
          }
          aria-haspopup={!selected && !compact ? "dialog" : undefined}
          onClick={(event: MouseEvent) =>
            selected
              ? onPick(file.name, event.shiftKey)
              : onOpen?.(file, event.currentTarget as HTMLButtonElement)
          }
        />
      )}
      <OverflowText className="prj-context-name" noTranslate text={name}>
        {compact && !file.source ? name.replace(/\.[^.]+$/, "") : name}
      </OverflowText>
      {compact && !file.source && /\.[^.]+$/.test(name) && (
        <small className="prj-context-type">
          {name.split(".").pop()?.toUpperCase()}
        </small>
      )}
      <small
        className={
          (file.source?.status === "failed" ||
            file.source?.status === "inaccessible") &&
          !syncing
            ? `prj-sync-failed${file.source?.status === "inaccessible" ? " prj-sync-inaccessible" : ""}`
            : undefined
        }
      >
        {file.source?.status === "failed" && !syncing && (
          <TriangleAlert size={16} aria-hidden="true" />
        )}
        <span>
          {file.source
            ? t(syncing ? "Syncing..." : knowledgeSourceLabel(file.source))
            : compact
              ? ""
              : formatSize(file.bytes)}
        </span>
      </small>
      {selected && !readOnly && (
        <input
          type="checkbox"
          aria-label={formatText("Select {name}", { name })}
          checked={selected.has(file.name)}
          onClick={(event) => onPick(file.name, event.shiftKey)}
          onChange={() => {}}
        />
      )}
      {!selected && !readOnly && (
        <button
          ref={anchor}
          type="button"
          className="prj-context-more"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={menu}
          disabled={busy}
          onClick={() => setMenu(!menu)}
        >
          <MoreVertical size={16} />
        </button>
      )}
      {menu && !readOnly && (
        <PageMenu
          label={label}
          width={200}
          anchor={anchor}
          onClose={() => setMenu(false)}
          entries={[
            ...(file.source && file.source.status !== "inaccessible" && onSync
              ? [
                  {
                    label: syncing
                      ? "Syncing..."
                      : file.source.status === "failed"
                        ? "Retry sync"
                        : "Sync now",
                    icon: RefreshCw,
                    disabled: busy,
                    onSelect: () => onSync(file.name),
                  },
                  { separator: true as const },
                ]
              : []),
            {
              label: "Remove from project",
              icon: Trash2,
              danger: true,
              onSelect: () => onRemove(file.name),
            },
          ]}
        />
      )}
    </div>
  );
}

export function knowledgeSourceLabel(
  source: NonNullable<KnowledgeFile["source"]>,
) {
  // 12e49f2-B8zRz5-9:493,1242 distinguishes inaccessible from failed.
  switch (source.failure) {
    case "reconnect":
      return "Reconnect source to sync";
    case "forbidden":
      return "Source access denied";
    case "not-found":
      return "Source no longer available";
    case "resolution":
      return "Source URL could not be resolved";
    default:
      return source.status === "inaccessible"
        ? "Source unavailable"
        : source.status === "failed"
          ? "Sync failed"
          : "Synced source";
  }
}

/**
 * The context list's search field and capacity row open to their height and
 * fade over 300ms on the original's knowledge-expand curve, and close back.
 */
export const KNOWLEDGE_EXPAND_MS = 300;

/** Older/partial bridges can expose an optional method without a list result. */
export function sourceNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}

/** "18.2kB", "2.4MB", "12B", as the original's context cards. */
export function formatSize(bytes: number) {
  if (bytes >= 1000 * 1000)
    return `${(bytes / 1000 / 1000).toFixed(1).replace(/\.0$/, "")}MB`;
  if (bytes >= 1000)
    return `${(bytes / 1000).toFixed(1).replace(/\.0$/, "")}kB`;
  return `${bytes}B`;
}

// The reference design: Progress tone thresholds.
export function capacityVariant(percent: number) {
  return percent >= 100 ? "danger" : percent > 80 ? "warning" : "accent";
}
