import type { MenuEntry } from "../ui/Menu";

/**
 * The Move to group submenu: a radio row per group (the current one checked), a
 * rule and Ungrouped when the conversation is in a group, then New group… (a
 * rule before it only when Ungrouped is not shown). The first nine rows are
 * numbered, and their digits pick them.
 */
export function moveToGroupEntries({
  groups,
  groupId,
  moveTo,
  newGroup,
}: {
  groups: { id: string; name: string }[];
  groupId: string | undefined;
  moveTo: (groupId: string | null) => void;
  newGroup: () => void;
}): MenuEntry[] {
  const hint = (index: number) => (index < 9 ? String(index + 1) : undefined);
  return [
    ...groups.map((group, index) => ({
      label: group.name,
      noTranslate: true,
      hint: hint(index),
      checked: group.id === groupId,
      onSelect: () => group.id !== groupId && moveTo(group.id),
    })),
    ...(groups.length && groupId ? [{ separator: true as const }] : []),
    ...(groupId
      ? [
          {
            label: "Ungrouped",
            hint: hint(groups.length),
            onSelect: () => moveTo(null),
          },
        ]
      : []),
    ...(groups.length && !groupId ? [{ separator: true as const }] : []),
    {
      label: "New group…",
      hint: hint(groups.length + (groupId ? 1 : 0)),
      onSelect: newGroup,
    },
  ];
}
