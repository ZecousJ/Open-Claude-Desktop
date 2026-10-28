import { useContext, type RefObject } from "react";
import { AppContext } from "../app/AppContext";
import { formatText } from "../i18n";
import { AppIcon, type AppIconName } from "../ui/app-icon";
import type { Conversation } from "../../shared/types";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { rowMenuWidth } from "./RowMenu";
import type { RowActions } from "./ConversationRow";
import { selection } from "./multi-select";
import { requestProjectMove } from "../collections/projects/project-move-request";
import {
  keepGroupWhileEmpty,
  setConversationGroups,
  useConversationGroups,
} from "./grouping";

/**
 * The actions a menu over several selected rows offers: each runs on the rows
 * it applies to and says how many, so a mixed selection offers both halves: Pin
 * {count} and Unpin {count}, Mark {count} as read and Mark {count} as unread,
 * then Archive {count} and Delete {count}. The single-key hints (P, U, A, D)
 * belong to the first of each pair.
 */
export function bulkEntries(
  rows: readonly Conversation[],
  actions: Pick<
    RowActions,
    "onTogglePin" | "onToggleUnread" | "onToggleArchive"
  > & {
    onDeleteMany?: (ids: string[]) => void;
    onMoveMany?: (rows: readonly Conversation[]) => void;
  },
  done: () => void,
  groups?: {
    list: { id: string; name: string }[];
    members: Record<string, string | undefined>;
    moveTo: (rows: readonly Conversation[], groupId: string | null) => void;
    /** New group…: asks for the name, then moves the rows into it. */
    newGroup?: (rows: readonly Conversation[]) => void;
  },
): MenuEntry[] {
  const projectId = rows[0]?.projectId;
  const sharedProject =
    Boolean(projectId) && rows.every((row) => row.projectId === projectId);
  const withState = (pick: (c: Conversation) => boolean) => ({
    yes: rows.filter(pick),
    no: rows.filter((c) => !pick(c)),
  });
  const pin = withState((c) => Boolean(c.pinned));
  const unread = withState((c) => Boolean(c.unread));
  const archive = withState((c) => Boolean(c.archived));
  const run = (list: Conversation[], act: (c: Conversation) => void) => () => {
    list.forEach(act);
    done();
  };
  const entry = (
    list: Conversation[],
    label: string,
    icon: AppIconName,
    act: (c: Conversation) => void,
    hint?: string,
    danger?: boolean,
  ): MenuEntry[] =>
    list.length
      ? [
          {
            label: formatText(label, { count: list.length }),
            noTranslate: true,
            icon: <AppIcon name={icon} size={20} />,
            ...(hint ? { hint } : {}),
            ...(danger ? { danger } : {}),
            onSelect: run(list, act),
          },
        ]
      : [];
  return [
    ...entry(pin.no, "Pin {count}", "Pin", actions.onTogglePin, "P"),
    ...entry(
      pin.yes,
      "Unpin {count}",
      "PinSlash",
      actions.onTogglePin,
      pin.no.length ? undefined : "P",
    ),
    ...entry(
      unread.yes,
      "Mark {count} as read",
      "Eye",
      actions.onToggleUnread,
      "U",
    ),
    ...entry(
      unread.no,
      "Mark {count} as unread",
      "EyeSlash",
      actions.onToggleUnread,
      unread.yes.length ? undefined : "U",
    ),
    ...(groups ? [moveToGroups(rows, groups, done)] : []),
    ...(actions.onMoveMany && rows.length && rows.every((row) => !row.incognito)
      ? [
          {
            label: sharedProject ? "Change project" : "Add to project",
            onSelect: () => actions.onMoveMany!(rows),
          },
        ]
      : []),
    ...entry(
      archive.no,
      "Archive {count}",
      "Archive",
      actions.onToggleArchive,
      "A",
    ),
    ...entry(
      archive.yes,
      "Unarchive {count}",
      "Archive",
      actions.onToggleArchive,
      archive.no.length ? undefined : "A",
    ),
    ...(actions.onDeleteMany
      ? [
          { separator: true as const },
          {
            label: formatText("Delete {count}", { count: rows.length }),
            noTranslate: true,
            danger: true,
            hint: "D",
            icon: <AppIcon name="Trash" size={20} />,
            onSelect: () => {
              actions.onDeleteMany!(rows.map((c) => c.id));
              done();
            },
          },
        ]
      : []),
  ];
}

/**
 * Move {count} to group: a row per group, checked when every selected row is in
 * it, then Ungrouped when any of them is in one, then New group… (a rule before
 * it only when Ungrouped is not shown), as a single row's submenu.
 */
function moveToGroups(
  rows: readonly Conversation[],
  groups: NonNullable<Parameters<typeof bulkEntries>[3]>,
  done: () => void,
): MenuEntry {
  const ids = rows.map((c) => groups.members[c.id]);
  const shared = ids.every((id) => id === ids[0]) ? ids[0] : undefined;
  const move = (target: string | null) => () => {
    groups.moveTo(rows, target);
    done();
  };
  const hint = (index: number) => (index < 9 ? String(index + 1) : undefined);
  const grouped = ids.some(Boolean);
  const { newGroup } = groups;
  return {
    label: formatText("Move {count} to group", { count: rows.length }),
    submenu: [
      ...groups.list.map((group, index) => ({
        label: group.name,
        noTranslate: true,
        hint: hint(index),
        checked: group.id === shared,
        onSelect: move(group.id),
      })),
      ...(grouped
        ? [
            ...(groups.list.length ? [{ separator: true as const }] : []),
            {
              label: "Ungrouped",
              hint: hint(groups.list.length),
              onSelect: move(null),
            },
          ]
        : []),
      ...(newGroup
        ? [
            ...(groups.list.length && !grouped
              ? [{ separator: true as const }]
              : []),
            {
              label: "New group…",
              hint: hint(groups.list.length + (grouped ? 1 : 0)),
              onSelect: () => {
                newGroup(rows);
                done();
              },
            },
          ]
        : []),
    ],
  };
}

export default function BulkRowMenu({
  rows,
  actions,
  position,
  anchor,
  onNewGroup,
  onClose,
}: {
  rows: Conversation[];
  actions: RowActions;
  /** New group… in Move to group: the list asks for the name in a dialog. */
  onNewGroup?: (rows: Conversation[]) => void;
  position: MenuPosition;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const app = useContext(AppContext);
  const groups = useConversationGroups();
  // As one row's Move to group: a pinned row moved into a group leaves
  // Pinned, and the group it leaves stays in view.
  const moveTo = (list: readonly Conversation[], target: string | null) =>
    void (async () => {
      for (const c of list) {
        const from = groups.members[c.id];
        if (from === (target ?? undefined)) continue;
        if (c.pinned && target !== null) actions.onTogglePin(c);
        const next = await window.desktop.moveConversationToGroup(c.id, target);
        if (from && from !== target) keepGroupWhileEmpty(from);
        setConversationGroups(next);
      }
    })().catch((error) => app?.report(error));
  const entries = bulkEntries(
    rows,
    {
      ...actions,
      onMoveMany: (list) =>
        requestProjectMove(list, (failed) => {
          const failures = new Set(failed);
          selection.prune(
            list.filter((row) => !failures.has(row.id)).map((row) => row.id),
          );
        }),
    },
    () => selection.clear(),
    {
      list: groups.groups,
      members: groups.members,
      moveTo,
      newGroup: onNewGroup && ((list) => onNewGroup([...list])),
    },
  );
  return (
    <Menu
      label={`Options for ${rows.length} selected`}
      // The web shows the single-key hints too.
      showRootHints
      className="row-menu"
      entries={entries}
      position={position}
      width={rowMenuWidth(entries)}
      anchors={[anchor]}
      onClose={onClose}
    />
  );
}
