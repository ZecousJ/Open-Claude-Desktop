import type { MenuEntry } from "../ui/Menu";
import {
  defaultCodeListView,
  isDefaultCodeListView,
  type CodeListView,
} from "./code-list-view";

export function codeListMenuEntries(
  value: CodeListView,
  onChange: (value: CodeListView) => void,
  onNewSection: () => void,
  onViewAll: () => void,
  classify = true,
): MenuEntry[] {
  const groups: (readonly [CodeListView["groupBy"], string])[] = [
    ["date", "Date"],
    ...(classify ? [["status", "Status"] as const] : []),
    ["folder", "Folder"],
    ["environment", "Environment"],
  ];
  const sorts: [CodeListView["sort"], string][] = [
    ["updated", "Last updated"],
    ["created", "Date created"],
    ["name", "Name"],
  ];
  return [
    {
      label: "Group by",
      value: groups.find(([v]) => v === value.groupBy)?.[1] ?? "None",
      submenu: [
        ...groups.map(([groupBy, label]) => ({
          label,
          checked: value.groupBy === groupBy,
          checkedRole: "radio" as const,
          keepOpen: true,
          onSelect: () => onChange({ ...value, groupBy }),
        })),
        { separator: true },
        {
          label: "None",
          checked: value.groupBy === "none",
          checkedRole: "radio",
          keepOpen: true,
          onSelect: () => onChange({ ...value, groupBy: "none" }),
        },
      ],
    },
    {
      label: "Sort by",
      value: sorts.find(([v]) => v === value.sort)![1],
      submenu: [
        ...sorts.map(([sort, label]) => ({
          label,
          checked: value.sort === sort,
          checkedRole: "radio" as const,
          keepOpen: true,
          onSelect: () => onChange({ ...value, sort }),
        })),
        { separator: true },
        ...(
          [
            [false, "Descending"],
            [true, "Ascending"],
          ] as const
        ).map(([ascending, label]) => ({
          label,
          checked: value.ascending === ascending,
          checkedRole: "radio" as const,
          keepOpen: true,
          onSelect: () => onChange({ ...value, ascending }),
        })),
      ],
    },
    {
      label: "Show",
      submenu: [
        {
          label: "Metadata",
          checked: value.metadata,
          checkedRole: "checkbox",
          keepOpen: true,
          onSelect: () => onChange({ ...value, metadata: !value.metadata }),
        },
        { separator: true },
        {
          label: "Empty groups",
          checked: value.emptyGroups,
          checkedRole: "checkbox",
          keepOpen: true,
          onSelect: () =>
            onChange({ ...value, emptyGroups: !value.emptyGroups }),
        },
      ],
    },
    { separator: true },
    { label: "New section", onSelect: onNewSection },
    { separator: true },
    {
      label: "Reset to defaults",
      disabled: isDefaultCodeListView(value),
      onSelect: () => onChange({ ...defaultCodeListView }),
    },
    { label: "View all", onSelect: onViewAll },
  ];
}
