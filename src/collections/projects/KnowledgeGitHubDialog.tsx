import { useEffect, useState } from "react";
import { Spinner } from "../../ui/Spinner";
import type { KnowledgeRepositoryFile } from "../../../shared/collections-api";
import { t, useT } from "../../i18n";
import { Modal } from "../../ui/Controls";
import { KnowledgeList } from "./KnowledgeList";

// GitHub project's picker copy.
export function KnowledgeGitHubDialog({
  projectId,
  repositories,
  onClose,
  onError,
  onAdd,
}: {
  projectId: string;
  repositories: string[];
  onClose: () => void;
  onError: (error: unknown) => void;
  onAdd: (
    repository: string,
    files: KnowledgeRepositoryFile[],
    branch: string,
  ) => void;
}) {
  useT();
  const [repository, setRepository] = useState(repositories[0] ?? "");
  const [branch, setBranch] = useState("HEAD");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<KnowledgeRepositoryFile[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!repository || !branch.trim()) return;
    let live = true;
    setFiles([]);
    setSelected(new Set());
    setLoading(true);
    const timer = setTimeout(() => {
      window.desktop
        .listProjectKnowledgeRepositoryFiles(
          projectId,
          repository,
          branch.trim(),
        )
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
  }, [projectId, repository, branch]);
  return (
    <Modal title="Add content from GitHub" onClose={onClose}>
      <p>Select the files you would like to add to this project</p>
      <form
        className="prj-text-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.size && !loading)
            onAdd(
              repository,
              files.filter((file) => selected.has(file.name)),
              branch.trim(),
            );
        }}
      >
        <label>
          Repository
          <select
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
          >
            {repositories.map((name) => (
              <option key={name} value={name} data-no-translate>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Branch
          <input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <input
          className="prj-knowledge-search"
          aria-label="Search files"
          placeholder={t("Search files")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {loading ? (
          <Spinner inheritColor className="spin" size={20} />
        ) : (
          <KnowledgeList
            files={files.map((file) => ({ ...file, addedAt: 0 }))}
            query={query}
            selected={selected}
            busy={false}
            onPick={(name) =>
              setSelected((previous) => {
                const next = new Set(previous);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              })
            }
            onRemove={() => {}}
          />
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
