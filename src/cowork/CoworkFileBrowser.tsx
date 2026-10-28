import { useEffect, useState, type KeyboardEvent } from "react";
import { File, FolderOpen, RefreshCw, Folder } from "../ui/glyphs";
import type { ProjectEntry } from "../../shared/project-files";
import type { CoworkFile } from "../../shared/cowork-api";
import { Modal } from "../ui/Controls";
import { ArtifactSource } from "../artifacts/ArtifactSource";
import { ArtifactPreview } from "../artifacts/ArtifactPreview";
import { artifactKind, previewKinds } from "../artifacts/artifact-kind";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { downloadArtifact } from "../artifacts/artifact-actions";
import { languageForPath } from "../diff/diff-model";
import { formatText, t } from "../i18n";
import type { ContextResource } from "./context-resources";
import "./cowork-file-browser.css";

export function FilePreview({ file }: { file: CoworkFile }) {
  const [error, setError] = useState<string>();
  const artifact = file.snapshot && generatedArtifact(file.snapshot);
  if (artifact)
    return (
      <>
        {error && <p role="alert">{error}</p>}
        {previewKinds.has(artifactKind(artifact)) || artifact.contentOmitted ? (
          <ArtifactPreview
            artifact={artifact}
            refresh={0}
            asDocument
            onError={(failure) => setError(String(failure))}
            onDownload={() => {
              void downloadArtifact(
                artifact,
                artifact.filename ?? artifact.name,
              ).catch((failure) => setError(String(failure)));
            }}
          />
        ) : (
          <ArtifactSource artifact={artifact} />
        )}
      </>
    );
  if (file.tooLarge)
    return (
      <p className="cowork-browser-empty">
        {formatText(
          "The file is too large to preview. Maximum size is {limit} MB.",
          { limit: (file.limitBytes ?? 2097152) / 1048576 },
        )}
      </p>
    );
  if (file.binary)
    return (
      <p className="cowork-browser-empty">This file type can’t be previewed.</p>
    );
  return (
    <ArtifactSource
      artifact={{
        id: file.path,
        name: file.path.split("/").at(-1) ?? file.path,
        language: languageForPath(file.path) ?? "text",
        content: file.content ?? "",
      }}
    />
  );
}

// Folder tree and preview.
export default function CoworkFileBrowser({
  conversationId,
  folders,
  initialFolder,
  local,
  onClose,
}: {
  conversationId: string;
  folders: string[];
  initialFolder: number;
  local: boolean;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialFolder);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<CoworkFile>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setFile(undefined);
    setError(undefined);
    if (!selected) return;
    let live = true;
    void window.desktop.readCoworkFile(conversationId, index, selected).then(
      (value) => {
        if (live) setFile(value);
      },
      (failure) => {
        if (live) setError(String(failure.message ?? failure));
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, index, selected, revision]);
  const basename = (path: string) =>
    path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return (
    <Modal
      title="Browse files"
      onClose={onClose}
      wide
      className="cowork-file-browser"
    >
      <div className="cowork-browser-body">
        {folders.length > 1 && (
          <div
            className="cowork-browser-tabs"
            role="tablist"
            aria-label="Working folders"
          >
            {folders.map((folder, at) => (
              <button
                key={folder}
                role="tab"
                aria-selected={index === at}
                onClick={() => {
                  setIndex(at);
                  setSelected(undefined);
                }}
                title={folder}
                data-no-translate
              >
                {basename(folder)}
              </button>
            ))}
          </div>
        )}
        <div className="cowork-browser-columns">
          <div className="cowork-browser-tree">
            <div className="cowork-browser-toolbar">
              <Folder size={16} />
              <span title={folders[index]} data-no-translate>
                {basename(folders[index])}
              </span>
              <button
                aria-label="Refresh"
                title={t("Refresh")}
                onClick={() => setRevision((value) => value + 1)}
              >
                <RefreshCw size={16} />
              </button>
              {local && (
                <button
                  aria-label="Open folder"
                  title={t("Open folder")}
                  onClick={() => {
                    void window.desktop
                      .revealCoworkFolder(conversationId, folders[index])
                      .catch((failure) =>
                        setError(String(failure.message ?? failure)),
                      );
                  }}
                >
                  <Folder size={16} />
                </button>
              )}
            </div>
            <div
              className="cowork-browser-tree-scroll"
              onKeyDown={navigateTree}
            >
              <FolderTree
                key={`${index}:${revision}`}
                conversationId={conversationId}
                index={index}
                path=""
                selected={selected}
                onSelect={setSelected}
              />
            </div>
          </div>
          <div className="cowork-browser-preview" aria-live="polite">
            {error ? (
              <p role="alert" className="cowork-browser-empty">
                {error}
              </p>
            ) : file ? (
              <FilePreview
                key={`${index}:${selected}:${revision}`}
                file={file}
              />
            ) : (
              <p className="cowork-browser-empty">
                {selected ? "Loading" : "Select a file to preview it."}
              </p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function navigateTree(event: KeyboardEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-depth]",
  );
  if (!row) return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button[data-depth]",
    ),
  ];
  const index = rows.indexOf(row);
  const depth = Number(row.dataset.depth);
  let target: HTMLButtonElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      target = rows[index + 1];
      break;
    case "ArrowUp":
      target = rows[index - 1];
      break;
    case "Home":
      target = rows[0];
      break;
    case "End":
      target = rows.at(-1);
      break;
    case "ArrowRight":
      if (row.getAttribute("aria-expanded") === "false") {
        event.preventDefault();
        row.click();
        return;
      }
      if (
        row.getAttribute("aria-expanded") === "true" &&
        Number(rows[index + 1]?.dataset.depth) > depth
      )
        target = rows[index + 1];
      break;
    case "ArrowLeft":
      if (row.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        row.click();
        return;
      }
      target = rows
        .slice(0, index)
        .reverse()
        .find((candidate) => Number(candidate.dataset.depth) < depth);
      break;
    default:
      if (event.key.length !== 1 || event.key === " ") return;
      target = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(
        (candidate) =>
          candidate.textContent
            ?.toLowerCase()
            .startsWith(event.key.toLowerCase()),
      );
  }
  event.preventDefault();
  target?.focus();
  target?.scrollIntoView({ block: "nearest" });
}

function FolderTree({
  conversationId,
  index,
  path,
  selected,
  onSelect,
  depth = 0,
}: {
  conversationId: string;
  index: number;
  path: string;
  selected?: string;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [entries, setEntries] = useState<ProjectEntry[]>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void window.desktop.listCoworkFolder(conversationId, index, path).then(
      (value) => {
        if (live) setEntries(value.entries);
      },
      (failure) => {
        if (live) setError(String(failure.message ?? failure));
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, index, path]);
  if (error)
    return (
      <p role="alert" className="cowork-browser-empty">
        {error}
      </p>
    );
  if (!entries) return <p className="cowork-browser-empty">Loading</p>;
  if (!entries.length)
    return <p className="cowork-browser-empty">Folder is empty.</p>;
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            className="cowork-browser-entry"
            data-depth={depth}
            aria-expanded={
              entry.kind === "folder" ? expanded.has(entry.path) : undefined
            }
            aria-current={selected === entry.path ? "true" : undefined}
            onClick={() => {
              if (entry.kind === "file") onSelect(entry.path);
              else
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
            }}
          >
            {entry.kind === "folder" ? (
              expanded.has(entry.path) ? (
                <FolderOpen size={16} />
              ) : (
                <Folder size={16} />
              )
            ) : (
              <File size={16} />
            )}
            <span data-no-translate>{entry.name}</span>
          </button>
          {entry.kind === "folder" && expanded.has(entry.path) && (
            <FolderTree
              conversationId={conversationId}
              index={index}
              path={entry.path}
              selected={selected}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function CoworkResourceDetails({
  conversationId,
  resource,
  onClose,
}: {
  conversationId: string;
  resource: ContextResource;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(
    resource.paths ? undefined : resource.path,
  );
  const [file, setFile] = useState<CoworkFile>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setFile(undefined);
    setError(undefined);
    if (!selected) return;
    let live = true;
    void window.desktop.readCoworkResource(conversationId, selected).then(
      (value) => {
        if (live) {
          setFile(value);
          setError(undefined);
        }
      },
      (failure) => {
        if (live) setError(String(failure.message ?? failure));
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, selected]);
  return (
    <Modal
      title={
        ["search", "memory", "browser", "instructions"].includes(resource.kind)
          ? t(resource.name)
          : resource.name
      }
      onClose={onClose}
      wide
      className="cowork-file-browser"
    >
      <div className="cowork-browser-resource">
        {resource.paths?.map((path) => (
          <button
            className="cowork-browser-entry"
            key={path}
            onClick={() => {
              setFile(undefined);
              setSelected(path);
            }}
            data-no-translate
          >
            <File size={16} />
            {path}
          </button>
        ))}
        {error ? (
          <p role="alert">{error}</p>
        ) : file ? (
          <FilePreview key={selected} file={file} />
        ) : selected ? (
          <p>Loading</p>
        ) : (
          resource.details?.map((detail, at) => (
            <pre key={at} data-no-translate>
              {detail}
            </pre>
          ))
        )}
      </div>
    </Modal>
  );
}
