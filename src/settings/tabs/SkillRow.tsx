import { createPortal } from "react-dom";
import { ConfirmationDialog } from "../../dialogs/ConfirmationDialog";
import { type MenuEntry } from "../../ui/Menu";
import { useRef, useState } from "react";
import { MoreVertical } from "../../ui/glyphs";
import { Menu, type MenuPosition } from "../../ui/Menu";
import { ScrollIcon } from "../../ui/icons";
import { editedLabel } from "../../collections/customize/customize-list";
import { type ListedSkill } from "./desktop-labels";
import "../desktop.css";
import "../directory/directory.css";
import "../../collections/customize/customize.css";

export function SkillRow({
  skill,
  edited,
  folders,
  run,
  onOpen,
  onName,
  onError,
}: {
  skill: ListedSkill;
  edited?: number;
  folders: boolean;
  run: (action: () => Promise<unknown>) => void;
  onOpen: () => void;
  /** Duplicate or Rename: opens the name dialog. */
  onName: (kind: "duplicate" | "rename") => void;
  onError: (error: unknown) => void;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const [deleting, setDeleting] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const on = skill.enabled !== false;
  const entries = skillMenu(
    skill,
    folders,
    run,
    () => setDeleting(true),
    onName,
  );
  return (
    <li className={on ? "" : "desktop-skill-off"}>
      <button type="button" className="desktop-skill-open" onClick={onOpen}>
        <span className="settings-list-tile">
          <ScrollIcon />
        </span>
        <span>
          <strong>
            {skill.name}
            {!on && <span className="desktop-skill-badge">Off</span>}
          </strong>
          <p>{skill.shortDescription || skill.description}</p>
        </span>
        {edited !== undefined && (
          <time
            className="desktop-skill-date"
            dateTime={new Date(edited).toISOString()}
          >
            {editedLabel(edited)}
          </time>
        )}
      </button>
      <button
        ref={more}
        type="button"
        className="desktop-row-more"
        aria-label={`More options for ${skill.name}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => {
          const rect = more.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: innerWidth - rect.right, top: rect.bottom + 4 },
          );
        }}
      >
        <MoreVertical size={17} />
      </button>
      {menu && (
        <Menu
          label={`Options for ${skill.name}`}
          size="regular"
          entries={entries}
          position={menu}
          width={180}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
      {deleting && (
        <RemoveSkill
          skill={skill}
          folders={folders}
          onDone={() => run(async () => {})}
          onClose={() => setDeleting(false)}
          onError={onError}
        />
      )}
    </li>
  );
}

/**
 * A skill's menu: Turn on/off, Rename (your own), Duplicate, Show in folder,
 * and Remove for your own.
 */
export function skillMenu(
  skill: ListedSkill,
  folders: boolean,
  run: (action: () => Promise<unknown>) => void,
  onRemove: () => void,
  onName: (kind: "duplicate" | "rename") => void,
): MenuEntry[] {
  const on = skill.enabled !== false;
  const own = (skill.scope ?? "user") === "user";
  const entries: MenuEntry[] = [
    {
      label: on ? "Turn off" : "Turn on",
      onSelect: () =>
        run(() => window.desktop.setSkillEnabled(skill.path, !on)),
    },
  ];
  if (own) entries.push({ label: "Rename", onSelect: () => onName("rename") });
  entries.push({ label: "Duplicate", onSelect: () => onName("duplicate") });
  if (folders)
    entries.push({
      label: "Show in folder",
      onSelect: () => run(() => window.desktop.revealSkill(skill.path)),
    });
  // Only skills added in Claudex live in the account's own skills folder.
  if (own)
    entries.push(
      { separator: true },
      // The original calls it Remove.
      { label: "Remove", danger: true, onSelect: onRemove },
    );
  return entries;
}

export function RemoveSkill({
  skill,
  folders,
  onDone,
  onClose,
  onError,
}: {
  skill: ListedSkill;
  folders: boolean;
  onDone: () => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  return createPortal(
    <ConfirmationDialog
      confirmation={{
        title: `Delete ${skill.name}?`,
        body: folders
          ? "The skill’s folder is removed from this computer. Conversations that used it are not changed."
          : "The skill is removed from your account. Conversations that used it are not changed.",
        action: async () => {
          await window.desktop.deleteSkill(skill.path);
          onDone();
        },
      }}
      onClose={onClose}
      onError={onError}
    />,
    document.body,
  );
}
