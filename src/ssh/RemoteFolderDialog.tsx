import { useEffect, useState } from "react";
import { ArrowUp } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { SshHost, SshStatus } from "../../shared/ssh-api";
import { FolderIcon } from "../ui/icons";
import { Modal } from "../ui/Controls";
import { bannerFor, childPath, parentPath } from "./model";

type Listing = {
  path: string;
  entries: { name: string; kind: "folder" | "file" }[];
};

/**
 * Choose a folder on an SSH host. It starts in the host's default folder or
 * home, lists the folders there, and takes a typed path. Open makes the listed
 * folder the working folder.
 */
export function RemoteFolderDialog({
  host,
  status,
  list,
  onConnect,
  onChoose,
  onClose,
}: {
  host: SshHost;
  status?: SshStatus;
  list: (path?: string) => Promise<Listing>;
  onConnect: () => void;
  onChoose: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing>();
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const ready = status?.state === "ready";
  const go = async (path?: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await list(path);
      setListing(next);
      setTyped(next.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!ready) {
      if (!status || status.state === "idle") onConnect();
      return;
    }
    if (!listing) void go(host.defaultFolder);
  }, [ready]);
  const waiting = !ready && bannerFor(status, host.label);
  const folders = listing?.entries
    .filter((entry) => entry.kind === "folder")
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal title={`Choose a folder on ${host.label}`} onClose={onClose}>
      <form
        className="ssh-folder"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed.trim() && typed.trim() !== listing?.path)
            void go(typed.trim());
        }}
      >
        <div className="ssh-folder-path">
          <button
            type="button"
            className="ssh-folder-up"
            aria-label="Parent folder"
            disabled={!listing || listing.path === "/" || loading}
            onClick={() => listing && void go(parentPath(listing.path))}
          >
            <ArrowUp size={16} strokeWidth={1.5} />
          </button>
          <input
            aria-label="Folder path"
            spellCheck={false}
            autoComplete="off"
            disabled={!ready}
            value={typed}
            placeholder="/home/you/project"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className="ssh-folder-list" role="listbox" aria-label="Folders">
          {waiting ? (
            <p className="ssh-folder-state">
              {waiting.busy && (
                <Spinner inheritColor size={14} className="spin" />
              )}
              {waiting.text}
              {waiting.action && (
                <button type="button" className="ssh-link" onClick={onConnect}>
                  {waiting.action.label}
                </button>
              )}
            </p>
          ) : loading && !listing ? (
            <p className="ssh-folder-state">
              <Spinner inheritColor size={14} className="spin" />
              Loading…
            </p>
          ) : folders?.length ? (
            folders.map((entry) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={entry.name}
                disabled={loading}
                onClick={() =>
                  listing && void go(childPath(listing.path, entry.name))
                }
              >
                <FolderIcon />
                <span>{entry.name}</span>
              </button>
            ))
          ) : listing ? (
            <p className="ssh-folder-state">No folders here.</p>
          ) : null}
        </div>
        {error && (
          <p className="ssh-test-result failed" role="status">
            {error}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!listing || loading || choosing}
            onClick={() => {
              if (!listing) return;
              setChoosing(true);
              void onChoose(listing.path)
                .then(onClose)
                .catch((reason) => {
                  setChoosing(false);
                  setError(
                    reason instanceof Error ? reason.message : String(reason),
                  );
                });
            }}
          >
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}
