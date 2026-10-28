import { Pencil, Pin, Trash2 } from "../ui/glyphs";
import type { Conversation, Project } from "../../shared/types";
import type { HostSurface } from "../../shared/host";
import { type MenuEntry } from "../ui/Menu";
import { fileManagerName } from "./file-manager";
import { projectEntries } from "./project-entries";
import { AppIcon } from "../ui/app-icon";
import type { RowMenuAbilities, RowMenuHandlers } from "./RowMenu";

/**
 * The row's More and right-click menu. Code: Open in ▸ (Split view on the
 * desktop, which the web's single pane leaves out; New window, the file
 * manager, a divider, Terminal), Pin, Mark as unread, Rename, Fork, a divider,
 * Share, Copy link, Export, a divider, Move to group, Archive, Delete. Chat and
 * Cowork: Open in new window, Pin, Rename, Add to project, Share, Copy link,
 * Move to group, Delete. What the window cannot do is left out.
 */
export function rowMenuEntries({
  conversation: c,
  projects,
  platform,
  can,
  moveToGroup,
  nestedSessionCount,
  surface: hostSurface = "desktop",
  on,
}: {
  conversation: Conversation;
  projects: Project[];
  platform: string;
  can: RowMenuAbilities;
  moveToGroup: MenuEntry;
  nestedSessionCount?: number;
  /** The web keeps Markdown export in the row instead of the title menu. */
  surface?: HostSurface;
  on: RowMenuHandlers;
}): MenuEntry[] {
  const pin: MenuEntry = {
    label: c.pinned ? "Unpin" : "Pin",
    hint: "P",
    icon: <Pin size={20} strokeWidth={1.5} />,
    onSelect: on.togglePin,
  };
  const rename: MenuEntry = {
    label: "Rename",
    hint: "R",
    icon: <Pencil size={20} strokeWidth={1.5} />,
    onSelect: on.rename,
  };
  const nested = nestedSessionCount ?? 0;
  const remove: MenuEntry = {
    label: "Delete",
    hint: "D",
    danger: true,
    icon: <Trash2 size={20} strokeWidth={1.5} />,
    onSelect: on.remove,
  };
  // An incognito chat never leaves this window or this computer.
  const newWindow = can.newWindow && !c.incognito;
  const sharing: MenuEntry[] = c.incognito
    ? []
    : [
        ...(can.share ? [{ label: "Share", onSelect: on.share }] : []),
        ...(can.copyLink
          ? [{ label: "Copy link", hint: "C", onSelect: on.copyLink }]
          : []),
      ];
  if (c.mode === "code") {
    // Split view and New window; then the editors this computer has, Terminal
    // and the file manager under "Open in"; then "Continue in" Cloud ("Runs
    // without your computer"). The headings show only with a Continue in row;
    // number keys follow the rows' places.
    type Place = { label: string; description?: string; onSelect: () => void };
    const layout: Place[] = [
      ...(can.splitView
        ? [{ label: "Split view", onSelect: on.openInSplit }]
        : []),
      ...(newWindow
        ? [{ label: "New window", onSelect: on.openInWindow }]
        : []),
    ];
    const places: Place[] = [
      ...(on.editors ?? []).map((editor) => ({
        label: editor.name,
        onSelect: editor.onSelect,
      })),
      ...(can.terminal
        ? [{ label: "Terminal", onSelect: () => on.openIn("terminal") }]
        : []),
      ...(on.openInDesktop
        ? [{ label: "Desktop app", onSelect: on.openInDesktop }]
        : []),
      ...(can.folder
        ? [
            {
              label: fileManagerName(platform),
              onSelect: () => on.openIn("folder"),
            },
          ]
        : []),
    ];
    const continueOn: Place[] = on.continueInCloud
      ? [
          {
            label: "Cloud",
            description: "Runs without your computer",
            onSelect: on.continueInCloud,
          },
        ]
      : [];
    const headed = continueOn.length > 0;
    let number = 0;
    const numbered = (place: Place): MenuEntry => ({
      ...place,
      ...(number < 9 ? { hint: String(++number) } : {}),
    });
    const sections: MenuEntry[][] = [
      layout.map(numbered),
      [
        ...(headed && places.length ? [{ heading: "Open in" }] : []),
        ...places.map(numbered),
      ],
      [
        ...(headed ? [{ heading: "Continue in" }] : []),
        ...continueOn.map(numbered),
      ],
    ].filter((section) => section.some((entry) => "label" in entry));
    const openIn: MenuEntry[] = sections.flatMap((section, index) => [
      ...(index ? [{ separator: true as const }] : []),
      ...section,
    ]);
    // Open PR heads the menu's first group, above Open in.
    const opening: MenuEntry[] = [
      ...(can.pullRequest && on.openPr
        ? [{ label: "Open PR", hint: "G", onSelect: on.openPr }]
        : []),
      ...(on.goToScheduledTask
        ? [{ label: "Go to scheduled task", onSelect: on.goToScheduledTask }]
        : []),
      ...(openIn.length ? [{ label: "Open in", submenu: openIn }] : []),
    ];
    const releaseRunner: MenuEntry[] =
      on.releaseRunner && c.mode === "code" && !c.runnerReleasedAt
        ? [{ label: "Release runner", onSelect: on.releaseRunner }]
        : [];
    // // the menu is groups with a rule between them. Edit holds Pin, Mark as
    // read or unread, Rename and Fork (key F); Share holds Share, Copy link
    // (key C) and Export (key E). Nested-session actions follow the same
    // conditional groups as the live menu. A web session is a cloud one: its
    // row has no Fork, Export or session settings; those belong to a session on
    // this computer.
    const cloud = hostSurface === "web";
    const share: MenuEntry[] = [
      ...sharing,
      ...(!cloud && can.export && on.exportConversation && !c.incognito
        ? [{ label: "Export", hint: "E", onSelect: on.exportConversation }]
        : []),
    ];
    // Code's items carry no icons, on the web too.
    const bare = (entry: MenuEntry): MenuEntry =>
      "label" in entry ? { ...entry, icon: undefined } : entry;
    return [
      // A rule sits under Open in, as in R-0044 and R-0083.
      ...(opening.length ? [...opening, { separator: true as const }] : []),
      bare(pin),
      {
        label: c.unread ? "Mark as read" : "Mark as unread",
        hint: "U",
        onSelect: on.toggleUnread,
      },
      bare(rename),
      // Only a session waiting for its review (or stopped by an error) is
      // marked complete, and title offers are suppressed only while one is on
      // offer.
      ...(on.markCompleted &&
      c.mode === "code" &&
      !c.completedAt &&
      c.sessionState === "ready_for_review"
        ? [{ label: "Mark as completed", onSelect: on.markCompleted }]
        : []),
      ...(on.suppressTitleOffers && !c.titleOffersSuppressed && c.titleOffer
        ? [{ label: "Suppress title offers", onSelect: on.suppressTitleOffers }]
        : []),
      ...(on.acceptTitleOffer &&
      c.titleOffer &&
      !c.titleOffersSuppressed &&
      c.titleOffer.proposedTitle !== c.title &&
      (!c.titleOffer.state || c.titleOffer.state === "offered") &&
      (c.titleOffer.titleAtOffer === undefined ||
        c.titleOffer.titleAtOffer === c.title)
        ? [{ label: "Use suggested title", onSelect: on.acceptTitleOffer }]
        : []),
      ...(on.detach && c.parentSessionId
        ? [{ label: "Detach session to top level", onSelect: on.detach }]
        : []),
      ...(nested > 0 && (on.hideNested || on.showNested)
        ? [
            {
              label: c.nestedSessionsHidden
                ? "Show nested sessions"
                : "Hide nested sessions",
              onSelect: c.nestedSessionsHidden ? on.showNested : on.hideNested,
            },
          ]
        : []),
      ...(!cloud && can.fork && on.fork
        ? [{ label: "Fork", hint: "F", onSelect: on.fork }]
        : []),
      ...(share.length ? [{ separator: true as const }, ...share] : []),
      // The session group: Transcript view, Output style, Release runner, Keep
      // computer awake.
      ...(!cloud &&
      (on.transcriptView ||
        on.outputStyle ||
        on.keepAwake ||
        releaseRunner.length)
        ? [{ separator: true as const }]
        : []),
      ...(!cloud && Array.isArray(on.transcriptView)
        ? [{ label: "Transcript view", submenu: on.transcriptView }]
        : []),
      ...(!cloud && Array.isArray(on.outputStyle)
        ? [{ label: "Output style", submenu: on.outputStyle }]
        : []),
      ...(cloud ? [] : releaseRunner),
      ...(on.keepAwake
        ? [
            {
              label: "Keep computer awake",
              description: "Only for this session",
              switched: on.keepAwake.on,
              keepOpen: true,
              onSelect: on.keepAwake.onToggle,
            },
          ]
        : []),
      { separator: true },
      // The organize group opens with Move up and Move down on a pinned row.
      ...(c.pinned && on.moveUp
        ? [{ label: "Move up", onSelect: on.moveUp }]
        : []),
      ...(c.pinned && on.moveDown
        ? [{ label: "Move down", onSelect: on.moveDown }]
        : []),
      bare(moveToGroup),
      { separator: true },
      {
        label: c.archived
          ? on.unarchiving === true
            ? "Unarchiving…"
            : "Unarchive"
          : "Archive",
        hint: "A",
        disabled: c.archived && on.unarchiving === true,
        onSelect: on.toggleArchive,
      },
      bare(remove),
    ];
  }
  // A Cowork task opens in a task window too (not a Chat or an incognito one).
  const quickTask: MenuEntry[] =
    c.mode === "cowork" && !c.incognito && on.openAsQuickTask
      ? [
          {
            label: "Open as quick task",
            icon: <AppIcon name="MinimizeBottomRight" />,
            disabled: can.quickTaskDisabled,
            onSelect: on.openAsQuickTask,
          },
          { separator: true },
        ]
      : [];
  return [
    ...quickTask,
    ...(newWindow
      ? [{ label: "Open in new window", onSelect: on.openInWindow }]
      : []),
    // a Chat row's menu leads with Mark as unread (EyeSlash; Mark as read, Eye)
    // and a rule, then Pin, Rename, Add to project and Move to group, a rule
    // and Delete; a Cowork task archives too. An incognito chat is never kept:
    // it has Delete only.
    ...(c.incognito
      ? []
      : [
          {
            label: c.unread ? "Mark as read" : "Mark as unread",
            hint: "U",
            icon: <AppIcon name={c.unread ? "Eye" : "EyeSlash"} size={20} />,
            onSelect: on.toggleUnread,
          },
          { separator: true as const },
          pin,
          rename,
          ...projectEntries(c, projects, on),
          ...sharing,
          ...(hostSurface === "web" && can.export && on.exportConversation
            ? [
                {
                  label: "Export",
                  hint: "E",
                  icon: <AppIcon name="Download" size={20} />,
                  onSelect: on.exportConversation,
                },
              ]
            : []),
          moveToGroup,
          { separator: true as const },
        ]),
    // O14 QX/Ns: an archived Chat exposes Unarchive even when the caller has
    // not offered Archive for a fresh chat. Do not infer that separate
    // offersArchive capability from the stored record kind.
    ...((c.mode === "cowork" || c.archived) && !c.incognito
      ? [
          {
            label: c.archived ? "Unarchive" : "Archive",
            hint: "A",
            icon: <AppIcon name="Archive" size={20} />,
            onSelect: on.toggleArchive,
          },
        ]
      : []),
    remove,
  ];
}
