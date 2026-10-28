import { useEffect, useState } from "react";
import { File as FileGlyph } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import type { KnowledgeDriveFile } from "../../../shared/collections-api";
import { t, useT } from "../../i18n";
import { Modal } from "../../ui/Controls";

// Drive picker copy.
export function KnowledgeDriveDialog({
  projectId,
  servers,
  onClose,
  onError,
  onAdd,
}: {
  projectId: string;
  servers: string[];
  onClose: () => void;
  onError: (error: unknown) => void;
  onAdd: (server: string, files: KnowledgeDriveFile[]) => void;
}) {
  useT();
  const [server, setServer] = useState(servers[0] ?? "");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<KnowledgeDriveFile[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setFiles([]);
    setSelected(new Set());
    setLoading(Boolean(query.trim() && server));
    if (!query.trim() || !server) return;
    const timer = setTimeout(() => {
      window.desktop
        .searchProjectKnowledgeDrive(projectId, server, query.trim())
        .then((files) => {
          if (live) setFiles(files);
        })
        .catch((error) => {
          if (live) onError(error);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId, server, query]);
  return (
    <Modal title="Google Drive" onClose={onClose}>
      <form
        className="prj-text-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading && selected.size)
            onAdd(
              server,
              files.filter((file) => selected.has(file.id)),
            );
        }}
      >
        {servers.length > 1 && (
          <label>
            Google Drive
            <select
              value={server}
              onChange={(event) => setServer(event.target.value)}
            >
              {servers.map((server) => (
                <option key={server} value={server} data-no-translate>
                  {server}
                </option>
              ))}
            </select>
          </label>
        )}
        <input
          autoFocus
          className="prj-knowledge-search"
          aria-label="Search Google Drive"
          placeholder={t("Search Google Drive")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {loading ? (
          <Spinner inheritColor className="spin" size={20} />
        ) : (
          <div className="prj-context-list">
            {files.map((file) => (
              <label className="prj-context-row" key={file.id}>
                <FileGlyph size={20} />
                <span className="prj-context-name" data-no-translate>
                  {file.title}
                </span>
                <input
                  type="checkbox"
                  aria-label={file.title}
                  checked={selected.has(file.id)}
                  onChange={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(file.id)) next.delete(file.id);
                      else next.add(file.id);
                      return next;
                    })
                  }
                />
              </label>
            ))}
            {!!query.trim() && !files.length && (
              <p className="prj-context-no-matches">No results found</p>
            )}
          </div>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={loading || !selected.size}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}
