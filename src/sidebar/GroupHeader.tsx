import { useContext, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EllipsisVertical, Pencil, Trash2 } from "../ui/glyphs";
import { AppContext } from "../app/AppContext";
import { formatText } from "../i18n";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { GroupNameDialog } from "./GroupNameDialog";
import {
  addedGroupId,
  currentConversationGroups,
  keepGroupWhileEmpty,
  setConversationGroups,
} from "./grouping";
import { GroupToggle } from "./GroupToggle";
import {
  collapseAllGroups,
  groupViewOptions,
  toggleGroups,
} from "./group-toggles";

/**
 * The heading of a custom group in the recent list, with a menu of its own (⋮
 * on hover, or a right click): Rename group, New group… and Delete group, which
 * asks first. Code's list calls its groups sections: Rename section, New
 * section, Delete section and its own confirmation. New group… asks for a name
 * and adds an empty group after the others, which this window keeps showing
 * while it is empty. Between them, Collapse all / Expand all turn every heading
 * in the list that collapses. The other headings (date, type, folder) are
 * names, or in Code toggles (ConversationList's GroupLabel).
 */
export function GroupHeader({
  label,
  groupId,
  members,
  list,
  collapsed,
  onToggle,
  section = false,
}: {
  label: string;
  groupId: string;
  /** Conversations in the group, for the delete confirmation. */
  members: number;
  /** The sidebar list, whose headings Collapse all and Expand all turn. */
  list?: RefObject<HTMLElement | null>;
  /** Whether the group's rows are hidden (Code's headings collapse). */
  collapsed?: boolean;
  /** Shows or hides the rows; without it the name is not a button. */
  onToggle?: () => void;
  /** Code's list: the groups read as sections. */
  section?: boolean;
}) {
  const app = useContext(AppContext);
  const [menu, setMenu] = useState<MenuPosition>();
  // What the view group offers, and the heading control that had focus, read as
  // the menu opens.
  const [view, setView] = useState<
    ReturnType<typeof groupViewOptions> & { opener: HTMLElement | null }
  >({ canCollapse: false, canExpand: false, opener: null });
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const report = (error: unknown) => app?.report(error);
  const open = (position: MenuPosition) => {
    const root = list?.current;
    const focused = document.activeElement as HTMLElement | null;
    setView({
      ...groupViewOptions(root),
      opener: focused && root?.contains(focused) ? focused : null,
    });
    setMenu(position);
  };
  const viewEntries: MenuEntry[] = [];
  if (view.canCollapse)
    viewEntries.push({
      label: "Collapse all",
      onSelect: () => collapseAllGroups(list?.current, view.opener),
    });
  if (view.canExpand)
    viewEntries.push({
      label: "Expand all",
      onSelect: () => toggleGroups(list?.current, "collapsed"),
    });
  const entries: MenuEntry[] = [
    {
      label: section ? "Rename section" : "Rename group",
      icon: <Pencil size={20} strokeWidth={1.5} />,
      onSelect: () => setRenaming(true),
    },
    {
      label: section ? "New section" : "New group…",
      onSelect: () => setCreating(true),
    },
    { separator: true },
    ...(viewEntries.length
      ? [...viewEntries, { separator: true } as const]
      : []),
    {
      label: section ? "Delete section" : "Delete group",
      danger: true,
      icon: <Trash2 size={20} strokeWidth={1.5} />,
      onSelect: () =>
        app?.setConfirm({
          title: section ? "Delete section?" : "Delete group?",
          // An empty group's body says nothing is in it.
          body: formatText(
            members === 0
              ? "“{groupName}” will be removed. Nothing is in it."
              : members === 1
                ? section
                  ? "“{groupName}” will be removed. The 1 session in it moves back to your other sessions."
                  : "“{groupName}” will be removed. The 1 item in it will no longer be grouped."
                : section
                  ? "“{groupName}” will be removed. The {count} sessions in it move back to your other sessions."
                  : "“{groupName}” will be removed. The {count} items in it will no longer be grouped.",
            { groupName: label, count: members },
          ),
          action: async () =>
            void setConversationGroups(
              await window.desktop.deleteConversationGroup(groupId),
            ),
        }),
    },
  ];
  return (
    <div
      className={`row-group-label${onToggle ? " has-toggle" : ""}`}
      data-roving-row=""
      data-drag-shift=""
      data-no-translate
      onContextMenu={(event) => {
        event.preventDefault();
        open({ left: event.clientX, top: event.clientY });
      }}
    >
      {onToggle ? (
        <GroupToggle
          label={label}
          collapsed={Boolean(collapsed)}
          onToggle={onToggle}
        />
      ) : (
        <span>{label}</span>
      )}
      <button
        ref={more}
        className="row-more"
        data-roving-item=""
        aria-label={`More options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={(event) => {
          if (menu) return setMenu(undefined);
          const box = event.currentTarget.getBoundingClientRect();
          open({ right: innerWidth - box.right, top: box.bottom + 7 });
        }}
      >
        <EllipsisVertical size={16} />
      </button>
      {menu && (
        <Menu
          label={`Options for ${label}`}
          entries={entries}
          position={menu}
          width={168}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
      {renaming &&
        // Out of the list: its mask would cut the dialog to the list's box.
        createPortal(
          <GroupNameDialog
            title={section ? "Rename section" : "Rename group"}
            section={section}
            initial={label}
            confirm="Save"
            onSubmit={async (name) =>
              void setConversationGroups(
                await window.desktop.renameConversationGroup(groupId, name),
              )
            }
            onError={report}
            onClose={() => setRenaming(false)}
          />,
          document.body,
        )}
      {creating &&
        createPortal(
          <GroupNameDialog
            title={section ? "New section" : "New group"}
            section={section}
            confirm={section ? "Create section" : "Create group"}
            onSubmit={async (name) => {
              const before = currentConversationGroups();
              const next = await window.desktop.createConversationGroup(name);
              const created = addedGroupId(before, next);
              if (created) keepGroupWhileEmpty(created);
              setConversationGroups(next);
            }}
            onError={report}
            onClose={() => setCreating(false)}
          />,
          document.body,
        )}
    </div>
  );
}
