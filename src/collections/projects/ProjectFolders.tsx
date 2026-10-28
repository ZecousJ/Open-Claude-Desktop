import { OverflowText } from "../../ui/OverflowText";
import { formatText, t, useLocale } from "../../i18n";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Check, Folder, Plus, X } from "../../ui/glyphs";
import type { Project } from "../../../shared/types";
import {
  addProjectFolder,
  projectFolderLimit,
  projectFolders,
  removeProjectFolder,
  replaceProjectFolder,
} from "../../../shared/project-folders";
import { AppContext } from "../../app/AppContext";
import { WithTooltip } from "../../ui/Tooltip";
import { FolderIcon, FolderPlusIcon, SearchIcon } from "../../ui/icons";
import { recentWorkFolders } from "../../composer/recentFolders";
import { menuKeydown } from "../../composer/CoworkOptions";
import { requestFolderAccess } from "../../cowork/useFolderAccess";
import "../../composer/cowork-options.css";
import { folderName } from "./project-list";

/** The system picker's title for a project's folder. */
const browsePrompt = "Choose a folder for the project";
/** Add a folder's system picker, which takes several (live: "Select folders"). */
const browseManyPrompt = "Select folders";

/** Why Add a folder is off once the project has 16 folders. */
export const folderLimitReason = "A project can have up to {max} folders.";

/**
 * Which of the chosen folders a project with `current` folders takes, and what
 * to say about the rest.
 */
export function foldersToAdd(
  current: readonly string[],
  chosen: readonly string[],
): { add: string[]; already: string[]; overLimit: number } {
  const unique = [...new Set(chosen.filter(Boolean))];
  const already = unique.filter((folder) => current.includes(folder));
  const fresh = unique.filter((folder) => !current.includes(folder));
  const room = Math.max(0, projectFolderLimit - current.length);
  return {
    add: fresh.slice(0, room),
    already,
    overLimit: Math.max(0, fresh.length - room),
  };
}

/** The picker's rows: recent folders minus the excluded, matching the search. */
export function folderPickerRows(
  recents: readonly string[],
  exclude: readonly string[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  return recents.filter(
    (folder) =>
      !exclude.includes(folder) &&
      (!needle ||
        folderName(folder).toLowerCase().includes(needle) ||
        folder.toLowerCase().includes(needle)),
  );
}

type Picker = {
  kind: "edit" | "add";
  anchor: DOMRect;
};

/**
 * A project's Folder section: "Folder" with the Only you badge; a row per
 * folder (icon, name, full path on hover, an X that shows on hover); "On
 * {deviceName}" under them. With one folder the header has Edit ("Choose a
 * different folder") and Add ("Add a folder"); with more, only Add, which is
 * off at 16 folders. Both open the folder picker (search, recent folders,
 * "Choose a different folder…"); without recent folders they go straight to the
 * system picker. Removing one of several folders asks first; the only folder
 * goes at once. Each folder passes Cowork's folder check, and the project keeps
 * the person's "Allow" so its new tasks get every folder.
 */
export function ProjectFolders({
  project,
  deviceName,
  onSave,
}: {
  project: Project;
  deviceName?: string;
  onSave: (project: Project) => Promise<void>;
}) {
  useLocale();
  const app = useContext(AppContext);
  const report = (error: unknown) => app?.report(error);
  const notify = (message: string) =>
    app ? app.notify(message) : report(new Error(message));
  const folders = projectFolders(project);
  const full = folders.length >= projectFolderLimit;
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<Picker>();
  const conversations = app?.snapshot.conversations;
  const recents = useMemo(
    () => recentWorkFolders(conversations ?? [], 8),
    [conversations],
  );
  // The latest project, for saves that finish after a folder check.
  const latest = useRef(project);
  latest.current = project;

  const save = async (next: (current: Project) => Project) => {
    setBusy(true);
    try {
      await onSave(next(latest.current));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  /** Cowork's folder check; true once the project may use the folder. */
  const allowed = async (folder: string) =>
    (await requestFolderAccess(folder, {
      projectId: project.id,
      notify,
    })) === "granted";

  const add = async (chosen: readonly string[]) => {
    const {
      add: fresh,
      already,
      overLimit,
    } = foldersToAdd(projectFolders(latest.current), chosen);
    if (already.length === 1)
      notify(
        formatText("{name} is already in this project.", {
          name: folderName(already[0]),
        }),
      );
    else if (already.length > 1)
      notify(
        formatText("{count} of these folders are already in this project.", {
          count: already.length,
        }),
      );
    if (overLimit)
      report(
        new Error(
          formatText(
            "A project can have up to {max} folders, so {count} weren't added.",
            { max: projectFolderLimit, count: overLimit },
          ),
        ),
      );
    const granted: string[] = [];
    try {
      for (const folder of fresh)
        if (await allowed(folder)) granted.push(folder);
    } catch (error) {
      report(error);
    }
    if (!granted.length) return;
    await save((current) =>
      granted.reduce((next, folder) => addProjectFolder(next, folder), current),
    );
  };
  const change = async (folder: string) => {
    const current = projectFolders(latest.current);
    if (current.length === 1 && current[0] === folder) return;
    try {
      if (!(await allowed(folder))) return;
    } catch (error) {
      return report(error);
    }
    await save((next) =>
      projectFolders(next).length
        ? replaceProjectFolder(next, folder)
        : addProjectFolder(next, folder),
    );
  };
  const remove = (folder: string) => {
    const only = projectFolders(latest.current).length <= 1;
    const drop = () => save((current) => removeProjectFolder(current, folder));
    if (only || !app) return void drop();
    app.setConfirm({
      title: t("Remove folder"),
      body: formatText("New tasks in this project won't use {name}.", {
        name: folderName(folder),
      }),
      confirm: t("Remove"),
      action: async () => {
        await onSave(removeProjectFolder(latest.current, folder));
      },
    });
  };
  /** The system picker: one folder for Edit, several for Add. */
  const browse = async (kind: Picker["kind"]) => {
    try {
      if (kind === "add" && folders.length > 0) {
        const chosen = await window.desktop.chooseFolders(t(browseManyPrompt));
        if (chosen.length) await add(chosen);
        return;
      }
      const chosen = await window.desktop.chooseFolder(t(browsePrompt));
      if (!chosen) return;
      if (kind === "edit") await change(chosen);
      else await add([chosen]);
    } catch (error) {
      report(error);
    }
  };
  const exclude = (kind: Picker["kind"]) => (kind === "add" ? folders : []);
  const open = (kind: Picker["kind"], button: HTMLElement) => {
    if (picker?.kind === kind) return setPicker(undefined);
    // No recent folder to offer: straight to the system picker (live).
    if (!folderPickerRows(recents, exclude(kind), "").length)
      return void browse(kind);
    setPicker({ kind, anchor: button.getBoundingClientRect() });
  };

  const addLabel = folders.length ? "Add a folder" : "Choose a folder";
  const addButton = full ? (
    <WithTooltip
      label={formatText(folderLimitReason, { max: projectFolderLimit })}
    >
      {(props) => (
        <button
          {...props}
          type="button"
          className="unavailable"
          aria-label={addLabel}
          aria-disabled="true"
        >
          <Plus size={16} strokeWidth={1.6} />
        </button>
      )}
    </WithTooltip>
  ) : (
    <button
      type="button"
      aria-label={addLabel}
      aria-haspopup="menu"
      aria-expanded={picker?.kind === "add"}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={(event) => open("add", event.currentTarget)}
    >
      <Plus size={16} strokeWidth={1.6} />
    </button>
  );
  return (
    <section>
      <div className="prj-side-head">
        <h2>Folders</h2>
        {folders.length === 1 && (
          <button
            type="button"
            aria-label="Choose a different folder"
            aria-haspopup="menu"
            aria-expanded={picker?.kind === "edit"}
            disabled={busy}
            onClick={(event) => open("edit", event.currentTarget)}
          >
            <Pencil size={16} strokeWidth={1.6} />
          </button>
        )}
        {addButton}
      </div>
      {folders.map((folder) => (
        <div key={folder} className="prj-folder-row">
          <Folder size={14} strokeWidth={1.5} aria-hidden="true" />
          <OverflowText className="prj-path" text={folder}>
            {folderName(folder)}
          </OverflowText>
          <button
            type="button"
            aria-label={formatText("Remove folder {name}", {
              name: folderName(folder),
            })}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => remove(folder)}
          >
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
      ))}
      {folders.length && deviceName ? (
        // Where the folders are: live names the device under the rows
        // ("On {deviceName}"); a Claudex project's folders are on this
        // computer.
        <p className="prj-muted prj-folder-where" data-no-translate>
          {formatText("On {deviceName}", { deviceName })}
        </p>
      ) : null}
      {folders.length ? null : (
        <p className="prj-muted">
          Add a folder on this computer for Claudex to work in.
        </p>
      )}
      {picker && (
        <FolderPicker
          anchor={picker.anchor}
          recents={recents}
          selected={picker.kind === "edit" ? folders : []}
          exclude={exclude(picker.kind)}
          onClose={() => setPicker(undefined)}
          onSelect={(folder) => {
            const kind = picker.kind;
            setPicker(undefined);
            void (kind === "edit" ? change(folder) : add([folder]));
          }}
          onBrowse={() => {
            const kind = picker.kind;
            setPicker(undefined);
            void browse(kind);
          }}
        />
      )}
    </section>
  );
}

/**
 * The folder picker: "Search folders", the recent folders (name over path, the
 * chosen one checked), then "Choose a different folder…" for the system picker.
 * It opens 4px under the button, right edges aligned, in the Cowork place
 * menu's measures.
 */
export function FolderPicker({
  anchor,
  recents,
  selected,
  exclude,
  onSelect,
  onBrowse,
  onClose,
}: {
  anchor: DOMRect;
  recents: readonly string[];
  selected: readonly string[];
  exclude: readonly string[];
  onSelect: (folder: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}) {
  useLocale();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const rows = folderPickerRows(recents, exclude, query);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose]);
  const width = 327;
  return createPortal(
    <div
      ref={box}
      className="cowork-menu prj-folder-menu"
      role="menu"
      aria-label="Select folder"
      style={{
        position: "fixed",
        top: anchor.bottom + 4,
        left: Math.max(8, Math.min(anchor.right, innerWidth - 8) - width),
      }}
      onKeyDown={(event) => menuKeydown(event, onClose)}
    >
      <label className="cowork-menu-search">
        <SearchIcon size={16} />
        <input
          autoFocus
          value={query}
          placeholder="Search folders"
          aria-label="Search folders"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter takes the first match, as the Cowork place menu does.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (rows[0]) onSelect(rows[0]);
          }}
        />
      </label>
      <div className="cowork-menu-list">
        {rows.length > 0 && (
          <div className="prj-folder-menu-heading" role="presentation">
            Recent
          </div>
        )}
        {rows.map((folder) => {
          const checked = selected.includes(folder);
          return (
            <button
              key={folder}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              onClick={() => onSelect(folder)}
            >
              <FolderIcon size={20} strokeWidth={1.25} />
              <span className="cowork-menu-text" data-no-translate>
                <strong>{folderName(folder)}</strong>
                <OverflowText as="small" text={folder} />
              </span>
              {checked && <Check size={14} />}
            </button>
          );
        })}
        {!rows.length && (
          <p className="cowork-menu-empty">
            {query.trim()
              ? "No matches"
              : "No recent folders. Browse to choose one."}
          </p>
        )}
      </div>
      <div className="cowork-menu-separator" role="separator" />
      <button type="button" role="menuitem" onClick={onBrowse}>
        <FolderPlusIcon size={20} strokeWidth={1.25} />
        <span className="cowork-menu-text">
          <strong>Choose a different folder…</strong>
        </span>
      </button>
    </div>,
    document.body,
  );
}
