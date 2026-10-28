import { useEffect, useState } from "react";
import type { DesktopAPI } from "../../../shared/types";
import { notAvailableOnWeb } from "../../../shared/web-bridge-methods";
import { Plus, X } from "../../ui/glyphs";
import { FolderIcon } from "../../ui/icons";
import { formatText } from "../../i18n";
import { Button, SettingsModal } from "../controls";

/** What trusting a folder means, under the row and in its dialog. */
export const trustedFoldersNote =
  "When you trust a folder on this device, you allow Claudex to use it and the folders inside it. Trusting a folder doesn’t add it to new tasks. When you add one to a task, you may be asked to allow it again.";

/** The last part of a folder path, for its remove button's name. */
export function trustedFolderName(folder: string) {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

/**
 * The trusted Cowork folders (R11-C). `undefined` until loaded, and stays
 * `undefined` where the bridge has no local folders (the web app), so the
 * row is not shown there. The list follows `cowork-folders` events, which
 * the main process pushes after "Always allow" in the access dialog.
 */
export function useTrustedCoworkFolders(onError: (error: unknown) => void) {
  const [folders, setFolders] = useState<string[]>();
  useEffect(() => watchTrustedFolders(window.desktop, setFolders, onError), []);
  return { folders, setFolders };
}

type TrustedFoldersBridge = Pick<
  DesktopAPI,
  "trustedCoworkFolders" | "onEvent"
>;

/**
 * Loads the trusted folders now and after every `cowork-folders` event;
 * returns the unsubscribe function. A bridge without local folders (the
 * web app) is not an error: the list just never arrives.
 */
export function watchTrustedFolders(
  desktop: TrustedFoldersBridge,
  set: (folders: string[]) => void,
  onError: (error: unknown) => void,
) {
  let live = true;
  // Only the newest request may set the list: an older reply that arrives
  // late would otherwise bring back a folder just removed.
  let latest = 0;
  const load = () => {
    const request = ++latest;
    return desktop
      .trustedCoworkFolders()
      .then((list) => {
        if (live && request === latest) set(list);
      })
      .catch((error: unknown) => {
        if (live && request === latest && !isUnavailable(error)) onError(error);
      });
  };
  void load();
  const off = desktop.onEvent((event) => {
    if (event.type === "cowork-folders") void load();
  });
  return () => {
    live = false;
    off();
  };
}

function isUnavailable(error: unknown) {
  return error instanceof Error && error.message.includes(notAvailableOnWeb);
}

/**
 * Settings → Cowork → Trusted Cowork folders → Manage. Lists the folders
 * Cowork may use (with the folders inside them) without asking, removes
 * them, and adds one with the main process's own folder picker: choosing it
 * here is the person's explicit trust, so no second prompt follows. The
 * page never passes a path to trust.
 */
export function TrustedFoldersDialog({
  folders,
  onChange,
  onClose,
  onError,
  title = "Trusted Cowork folders",
  note = trustedFoldersNote,
  add = () => window.desktop.addTrustedCoworkFolder(),
  remove = (folder) => window.desktop.removeTrustedCoworkFolder(folder),
  empty,
}: {
  folders: string[];
  onChange: (folders: string[]) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
  /** Another list of trusted folders (Settings → Claude Code's workspaces). */
  title?: string;
  note?: string;
  add?: () => Promise<string[]>;
  remove?: (folder: string) => Promise<string[]>;
  /** What the empty list says. */
  empty?: string;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<string[]>) => {
    setBusy(true);
    try {
      onChange(await action());
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsModal title={title} onClose={onClose}>
      <p className="desktop-dialog-note">{note}</p>
      <TrustedFoldersList
        folders={folders}
        busy={busy}
        label={title}
        empty={empty}
        onRemove={(folder) => void run(() => remove(folder))}
      />
      <div className="button-row desktop-trusted-actions">
        <Button size="regular" disabled={busy} onClick={() => void run(add)}>
          <Plus size={16} aria-hidden="true" />
          Add folder
        </Button>
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </SettingsModal>
  );
}

/** The dialog's list of trusted folders, or its empty state. */
export function TrustedFoldersList({
  folders,
  busy,
  onRemove,
  label = "Trusted Cowork folders",
  empty = "No trusted folders yet.",
}: {
  folders: string[];
  busy: boolean;
  onRemove: (folder: string) => void;
  label?: string;
  empty?: string;
}) {
  if (folders.length === 0)
    return <p className="desktop-trusted-empty">{empty}</p>;
  return (
    <ul className="desktop-trusted" aria-label={label}>
      {folders.map((folder) => (
        <li key={folder}>
          <FolderIcon className="desktop-trusted-icon" size={16} />
          <span title={folder}>{folder}</span>
          {/* Claudex's Always allow trusts the folder itself: there is no
              separate remembered "Don't ask again" list to mark. */}
          <button
            type="button"
            className="desktop-trusted-remove"
            aria-label="Remove"
            title={formatText("Remove {name}", {
              name: trustedFolderName(folder),
            })}
            disabled={busy}
            onClick={() => onRemove(folder)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
