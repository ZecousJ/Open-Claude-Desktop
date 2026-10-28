import { useRef, useState, type ReactNode } from "react";
import { ArrowUpDown } from "../ui/glyphs";
import type { Mode } from "../../shared/types";
import { AppIcon } from "../ui/app-icon";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { useTooltip } from "../ui/Tooltip";
import { defaultFilter, type ListFilter } from "./listFilter";

type Option<K extends keyof ListFilter> = [ListFilter[K], string];

const typeOptions: Option<"type">[] = [
  ["all", "All"],
  ["chat", "Chat"],
  ["cowork", "Task"],
];
const statusOptions: Option<"status">[] = [
  ["active", "Active"],
  ["archived", "Archived"],
  ["all", "All"],
];
const activityOptions: Option<"activity">[] = [
  [1, "1d"],
  [3, "3d"],
  [7, "7d"],
  [30, "30d"],
  ["all", "All"],
];
// Chat: Date, Type, Unread, Custom groups; Code: Date, Folder, State, Custom
// groups. Code's State is shown but disabled: Claudex has no remote session
// states to group by.
const chatGroupOptions: Option<"groupBy">[] = [
  ["date", "Date"],
  ["type", "Type"],
  ["unread", "Unread"],
  ["custom", "Custom groups"],
];
// Current unified Chat: O16 shared20 rt + R18 actual web/native inventory.
// Legacy History and Code retain their independent choices below.
const unifiedChatGroupOptions: Option<"groupBy">[] = [
  ["date", "Date"],
  ["unread", "Unread"],
  ["state", "State"],
  ["custom", "Custom groups"],
];
const codeGroupOptions: Option<"groupBy">[] = [
  ["date", "Date"],
  ["folder", "Folder"],
  ["custom", "Custom groups"],
];
// All environments above a divider, then each environment. Cloud, Remote
// Control and Slack are not offered.
const environmentOptions: Option<"environment">[] = [
  ["local", "Local"],
  ["ssh", "SSH"],
];
/** Why a captured entry is shown but cannot be chosen yet (UI first). */
export const unavailableReasons = {
  cloud: "Cloud sessions aren't available in Claudex yet",
  remoteControl: "Remote Control isn't available in Claudex yet",
  slack: "Slack sessions aren't available in Claudex yet",
  state: "Session states aren't available in Claudex yet",
};
// Local, Cloud, Remote Control, SSH, Slack.
const environmentRows: (Option<"environment"> | [undefined, string, string])[] =
  [
    environmentOptions[0],
    [undefined, "Cloud", unavailableReasons.cloud],
    [undefined, "Remote Control", unavailableReasons.remoteControl],
    environmentOptions[1],
    [undefined, "Slack", unavailableReasons.slack],
  ];
const sortOptions: Option<"sort">[] = [
  ["name", "Name"],
  ["created", "Date created"],
  ["activity", "Last activity"],
];

/**
 * The menu's entries for a surface and filter; also read by tests.
 * `emptyGroups`: the list can show empty custom groups (the sidebar's, not
 * the history page's), so Code offers Show empty groups. `prStatus`: the
 * list's rows show their pull request (the sidebar's), so Code offers Show
 * PR status.
 */
export function historyFilterEntries(
  mode: Mode,
  value: ListFilter,
  onChange: (value: ListFilter) => void,
  {
    emptyGroups = false,
    prStatus = false,
    unifiedChat = false,
  }: { emptyGroups?: boolean; prStatus?: boolean; unifiedChat?: boolean } = {},
): MenuEntry[] {
  const choice = <K extends keyof ListFilter>(
    key: K,
    label: string,
    options: Option<K>[],
  ): MenuEntry => ({
    label,
    value: options.find(([v]) => v === value[key])?.[1],
    submenu: options.map(([v, text]) => ({
      label: text,
      checked: v === value[key],
      onSelect: () => onChange({ ...value, [key]: v }),
    })),
  });
  const environment: MenuEntry = {
    label: "Environment",
    value:
      environmentOptions.find(([v]) => v === value.environment)?.[1] ?? "All",
    submenu: [
      {
        label: "All environments",
        checked: (value.environment ?? "all") === "all",
        onSelect: () => onChange({ ...value, environment: "all" }),
      },
      { separator: true },
      ...environmentRows.map(([v, text, reason]): MenuEntry =>
        v === undefined
          ? { label: text, title: reason, disabled: true }
          : {
              label: text,
              checked: v === value.environment,
              onSelect: () => onChange({ ...value, environment: v }),
            },
      ),
    ],
  };
  const groupOptions =
    mode === "code"
      ? codeGroupOptions
      : unifiedChat
        ? unifiedChatGroupOptions
        : chatGroupOptions;
  // None sits below a divider, as in the captured submenu.
  const groupBy: MenuEntry = {
    label: "Group by",
    value: groupOptions.find(([v]) => v === value.groupBy)?.[1] ?? "None",
    submenu: [
      ...groupOptions.flatMap(([v, text]): MenuEntry[] => {
        const row: MenuEntry = {
          label: text,
          checked: v === value.groupBy,
          onSelect: () => onChange({ ...value, groupBy: v }),
        };
        return mode === "code" && v === "folder"
          ? [
              row,
              {
                label: "State",
                title: unavailableReasons.state,
                disabled: true,
              },
            ]
          : [row];
      }),
      { separator: true },
      {
        label: "None",
        checked: !groupOptions.some(([v]) => v === value.groupBy),
        onSelect: () => onChange({ ...value, groupBy: "none" }),
      },
    ],
  };
  // Once anything differs from the defaults the menu ends with a way back:
  // Clear filters in Code, Reset to defaults in Chat.
  const reset: MenuEntry[] = isDefaultFilter(value)
    ? []
    : [
        { separator: true },
        {
          label: mode === "code" ? "Clear filters" : "Reset to defaults",
          onSelect: () =>
            onChange({
              ...defaultFilter,
              showPrStatus: value.showPrStatus ?? defaultFilter.showPrStatus,
            }),
        },
      ];
  const views: MenuEntry[] = [
    // Code's menu offers Show empty groups above Show PR status while the list
    // is grouped by custom group; the check toggles and the menu stays open.
    ...(emptyGroups && value.groupBy === "custom"
      ? [
          {
            label: "Show empty groups",
            checked: Boolean(value.showEmptyGroups),
            keepOpen: true,
            onSelect: () =>
              onChange({
                ...value,
                showEmptyGroups: !value.showEmptyGroups,
              }),
          },
        ]
      : []),
    // The sidebar's rows show their pull request's state while this is checked
    // (on by default); it toggles and the menu stays open. The History page's
    // list has no PR glyphs, so its menu leaves it out.
    ...(mode === "code" && prStatus
      ? [
          {
            label: "Show PR status",
            checked: value.showPrStatus !== false,
            keepOpen: true,
            onSelect: () =>
              onChange({
                ...value,
                showPrStatus: value.showPrStatus === false,
              }),
          },
        ]
      : []),
  ];
  return mode === "code"
    ? [
        choice("status", "Status", statusOptions),
        environment,
        { separator: true },
        groupBy,
        choice("sort", "Sort by", sortOptions),
        ...(views.length ? [{ separator: true as const }, ...views] : []),
        ...reset,
      ]
    : [
        choice("status", "Status", statusOptions),
        choice("activity", "Last activity", activityOptions),
        { separator: true },
        groupBy,
        choice("sort", "Sort by", sortOptions),
        ...(unifiedChat && views.length
          ? [{ separator: true as const }, ...views]
          : []),
        ...reset,
      ];
}

/**
 * Every choice, sort included, is the default one. Show empty groups counts
 * only while it is offered, that is while the list is grouped by custom group,
 * which already differs from the default, so it is not compared on its own.
 * Show PR status is how the rows look, not which rows show, and Clear filters
 * leaves it.
 */
export function isDefaultFilter(value: ListFilter) {
  return (Object.keys(defaultFilter) as (keyof ListFilter)[]).every(
    (key) =>
      key === "showEmptyGroups" ||
      key === "showPrStatus" ||
      (value[key] ?? defaultFilter[key]) === defaultFilter[key],
  );
}

/**
 * The recent list's filter menu. Chat shows Type, Status and Last activity;
 * Code shows Status and Environment, groups, sorts and ends with Show PR
 * status. Both group (Custom groups included) and sort. Entries without a
 * Claudex backend (Cloud, Remote Control and Slack environments, State
 * grouping) are shown disabled with the reason as a tooltip.
 */
export function HistoryFilter({
  mode,
  value,
  onChange,
  className = "",
  // The icon font's Filter, 16px, on every surface.
  icon = <AppIcon name="Filter" size={16} />,
  buttonLabel,
  emptyGroups,
  prStatus,
  unifiedChat = false,
}: {
  mode: Mode;
  value: ListFilter;
  onChange: (value: ListFilter) => void;
  /** The button's accessible name where it differs from the menu's. */
  buttonLabel?: string;
  /** The list can show empty custom groups: Code offers Show empty groups. */
  emptyGroups?: boolean;
  /** The list's rows show their pull request: Code offers Show PR status. */
  prStatus?: boolean;
  /** Current main Chat sidebar; the independent History/legacy menu stays separate. */
  unifiedChat?: boolean;
  /** The History page reuses the menu behind its own 32px button and glyph. */
  className?: string;
  icon?: ReactNode;
}) {
  const [position, setPosition] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  // The tooltip says what the button is called; the History page's button is
  // plain Filter.
  const tip = useTooltip(buttonLabel ?? "Filter", {
    disabled: Boolean(position),
  });
  const label = mode === "code" ? "Filter sessions" : "Filter chats";
  const entries = historyFilterEntries(mode, value, onChange, {
    emptyGroups,
    prStatus,
    unifiedChat,
  });
  return (
    <>
      <button
        ref={anchor}
        {...tip.props}
        className={
          [className, position && "open"].filter(Boolean).join(" ") || undefined
        }
        aria-label={buttonLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        onClick={(event) => {
          if (position) return setPosition(undefined);
          const box = event.currentTarget.getBoundingClientRect();
          // Measured: right-aligned with the button, 4px below it.
          setPosition({ left: box.right - 200, top: box.bottom + 4 });
        }}
      >
        {icon}
      </button>
      {tip.tooltip}
      {position && (
        <Menu
          label={label}
          entries={entries}
          position={position}
          width={200}
          anchors={[anchor]}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

/**
 * Sort, beside Filter while the Chats and tasks page searches: the filter
 * menu's Sort by choices behind their own ↑↓ button.
 */
export function HistorySort({
  value,
  onChange,
  className = "",
}: {
  value: ListFilter;
  onChange: (value: ListFilter) => void;
  className?: string;
}) {
  const [position, setPosition] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        className={
          [className, position && "open"].filter(Boolean).join(" ") || undefined
        }
        aria-label="Sort"
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        onClick={(event) => {
          if (position) return setPosition(undefined);
          const box = event.currentTarget.getBoundingClientRect();
          setPosition({ left: box.right - 200, top: box.bottom + 4 });
        }}
      >
        <ArrowUpDown size={16} strokeWidth={1.5} />
      </button>
      {position && (
        <Menu
          label="Sort"
          entries={[
            { heading: "Sort by" },
            ...sortOptions.map(([sort, label]) => ({
              label,
              checked: value.sort === sort,
              onSelect: () => onChange({ ...value, sort }),
            })),
          ]}
          position={position}
          width={200}
          anchors={[anchor]}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

/**
 * Whether the filter narrows or groups the list (its button shows it). Show
 * empty groups only matters while grouped by custom group, which already
 * counts.
 */
export function filterActive(value: ListFilter) {
  return (Object.keys(defaultFilter) as (keyof ListFilter)[]).some(
    (key) =>
      key !== "sort" &&
      key !== "showEmptyGroups" &&
      key !== "showPrStatus" &&
      value[key] !== defaultFilter[key],
  );
}
