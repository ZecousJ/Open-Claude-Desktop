import { useRef, useState } from "react";
import { surface } from "../../shared/host";
import { formatText } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import type { Conversation, Project } from "../../shared/types";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import { projectEntries } from "../sidebar/project-entries";
import {
  transcriptViewLabels,
  transcriptViews,
} from "../../shared/transcript-view";
import type { TranscriptViewMenu } from "../transcript-view/useTranscriptViewActions";
import { builtInOutputStyleNames } from "../../shared/output-style-names";

export type TitleActions = {
  /** Code: See background tasks (the panel), when the session has any. */
  onSeeBackgroundTasks?: () => void;
  /** Code: Clear background tasks, when some finished. */
  onClearBackgroundTasks?: () => void;
  onPin: () => void;
  /** Chat: Mark as unread / Mark as read. */
  onToggleUnread?: () => void;
  /** Chat: the Move to group row, built where the person's groups are known. */
  moveToGroup?: MenuEntry;
  onRename: (title: string) => void;
  /**
   * Opens the Rename dialog instead of editing the title in place: the
   * original's title menu opens a "Rename chat" dialog over the open
   * conversation, while the sidebar row edits in place. Absent, the title
   * edits in place.
   */
  onRenameDialog?: () => void;
  /** A project id, or null to take the conversation out of its project. */
  onMoveToProject: (projectId: string | null) => void;
  /** Opens the project editor; the new project receives this conversation. */
  /** Opens the new project dialog, named when a name was typed. */
  onCreateProject: (name?: string) => void;
  onOpenProjects: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Code: export the transcript. Chat export remains outside this title menu. */
  onExport?: () => void;
  /** Opens the same hosted sharing flow as the header's Share button. */
  onShare?: () => void;
  /** Open in ▸ New window (R2), where separate windows exist. */
  onOpenInWindow?: () => void;
  /** Code: Fork session, a new session continuing this one. */
  onFork?: () => void;
  /** Why Fork is greyed when there is no onFork; the original passes forkDisabledReason the same way. */
  forkDisabledReason?: string;
  /**
   * Code: Continue in ▸ Cloud, a local session moving to a cloud session on
   * its branch (ContinueInCloudDialog.tsx).
   */
  onContinueInCloud?: () => void;
  /** Open in ▸ Finder: the session's folder in the file manager. */
  onRevealFolder?: () => void;
  /** The file manager's name for Open in (Finder, File Explorer). */
  fileManager?: string;
  /** Code: the session's Transcript view (Normal, Thinking, Verbose). */
  transcriptView?: TranscriptViewMenu;
  /** Code: Open in ▸ Split view, a pane beside this one (desktop). */
  onOpenInSplit?: () => void;
  /** Code: Open in ▸ Terminal, the session's terminal panel. */
  onOpenTerminal?: () => void;
  /** Code: Open in ▸ Desktop app, a cloud session in the desktop app. */
  onOpenInDesktop?: () => void;
  /** Code: Edit cloud environment, the cloud session's environment. */
  onEditEnvironment?: () => void;
  /** Code: Open in ▸ the installed editors, by name. */
  editors?: { name: string; onSelect: () => void }[];
  /** Code: Open PR (key G), the pull request the session made. */
  onOpenPr?: () => void;
  /** A currently usable service link; the host revalidates it before copying. */
  onCopyLink?: () => void;
  /** Code: Keep computer awake, only for this session (a switch row). */
  keepAwake?: { on: boolean; onToggle: () => void };
  outputStyle?: { name: string; onSelect: () => void }[];
  onNewOutputStyle?: () => void;
};

/** Why the Code title menu's rows without a Claudex counterpart are greyed. */
export const codeMenuReasons = {
  editor: "Opening a session in an editor isn't available in Claudex yet",
  cloud: "Cloud environments aren't available in Claudex yet",
  fork: "Forking a session isn't available in Claudex yet",
  transcript: "Other transcript views aren't available in Claudex yet",
  outputStyle: "Output style",
} as const;

/**
 * The header's project breadcrumb and title. Chat's title starts Rename; the
 * separate caret opens its menu, and a web Code session's the same with its
 * caret. The desktop's Code title keeps the combined menu button. Rename uses
 * the existing dialog or in-place field.
 */
export function ConversationTitle({
  conversation: c,
  projects,
  running,
  actions,
}: {
  conversation: Conversation;
  projects: Project[];
  running: boolean;
  actions: TitleActions;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const [renaming, setRenaming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const renameTrigger = useRef<HTMLButtonElement>(null);
  const project = projects.find((p) => p.id === c.projectId);
  // A Code session's title edits in place (the original's header passes
  // onRenameStart); Chat and Cowork open the Rename dialog where there is one.
  const code = c.mode === "code";
  // The desktop's Code title is one menu button; on the web a Code session's
  // title starts Rename and a separate caret opens the menu, as Chat's does.
  const combined = code && surface !== "web";
  const webChat = surface === "web" && !code;
  const webCode = surface === "web" && code;
  const nativeChat = surface !== "web" && !code;
  const menuWidth = code ? (actions.keepAwake ? 224 : 160) : 170;
  const startRename = () =>
    actions.onRenameDialog && !code
      ? actions.onRenameDialog()
      : setRenaming(true);
  const toggleMenu = () => {
    if (menu) return setMenu(undefined);
    const box = trigger.current!.getBoundingClientRect();
    if (webCode) {
      // the compact menu opens 5px before the caret and 2px under it, as wide
      // as its rows.
      setMenu({
        left: Math.max(8, Math.min(box.left - 5, window.innerWidth - 180)),
        top: box.bottom + 2,
      });
      return;
    }
    if (nativeChat) {
      // The compact native popup is content-sized and ends at the caret.
      // O16 shared-frame:11406ff (min128/max320); R15 native title capture.
      setMenu({
        right: Math.max(8, window.innerWidth - box.right),
        top: box.bottom + 4,
      });
      return;
    }
    setMenu({
      // The chat menu ends at the separate caret's right edge. Keep its frame
      // inside either side of a narrow viewport.
      left: Math.max(
        8,
        Math.min(
          webChat ? box.right - menuWidth : box.left,
          window.innerWidth - menuWidth - 8,
        ),
      ),
      top: box.bottom + (webChat ? 6 : 4),
    });
  };
  const entries = titleMenuEntries(c, projects, running, {
    ...actions,
    onRename: startRename,
    onShare: actions.onShare
      ? () => {
          // A warm share chunk mounts in the same commit that removes its
          // menu item. Give it a stable opener before it captures focus.
          trigger.current?.focus({ preventScroll: true });
          actions.onShare?.();
        }
      : undefined,
  });
  // The original cuts a long title at 80 characters with an ellipsis.
  const shownTitle =
    code && [...c.title].length > 80
      ? `${[...c.title].slice(0, 79).join("").trimEnd()}…`
      : c.title;
  return (
    <div className="thread-heading">
      {project && (
        // The project name before the title leads back to Projects.
        <>
          <button
            className="thread-project"
            title={`Open projects`}
            onClick={actions.onOpenProjects}
          >
            {project.name}
          </button>
          <span className="thread-crumb-sep" aria-hidden="true">
            /
          </span>
        </>
      )}
      {renaming ? (
        <RenameField
          className={code ? "thread-rename code" : "thread-rename"}
          label={code ? "Session name" : undefined}
          selectAll={code}
          sized={code}
          title={c.title}
          onDone={(title) => {
            setRenaming(false);
            if (title && title !== c.title) actions.onRename(title);
            requestAnimationFrame(() =>
              (combined ? trigger : renameTrigger).current?.focus(),
            );
          }}
        />
      ) : combined ? (
        <button
          ref={trigger}
          className="thread-title"
          data-mode={c.mode}
          aria-label={formatText("More options for {label}", {
            label: c.title.trim(),
          })}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          data-open={Boolean(menu)}
          onClick={toggleMenu}
        >
          <span>{shownTitle}</span>
          {/* The original's caret (its icon font, 16px). */}
          <AppIcon name="CaretDownMedium" />
        </button>
      ) : (
        <div className="thread-title-split" data-mode={c.mode}>
          <button
            ref={renameTrigger}
            className="thread-rename-trigger"
            aria-label={formatText("{title}, rename session", {
              title: c.title,
            })}
            onClick={startRename}
          >
            <span data-no-translate>{shownTitle}</span>
          </button>
          <button
            ref={trigger}
            className="thread-menu-trigger"
            aria-label={formatText("More options for {label}", {
              label: c.title.trim(),
            })}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            data-open={Boolean(menu)}
            onClick={toggleMenu}
          >
            <AppIcon name={code ? "CaretDown" : "CaretDownMedium"} />
          </button>
        </div>
      )}
      {menu && (
        <Menu
          className={
            webChat
              ? "conversation-title-menu"
              : webCode
                ? "code-title-menu"
                : nativeChat
                  ? "native-conversation-title-menu"
                  : undefined
          }
          submenuClassName={webCode ? "code-title-menu" : undefined}
          showRootHints={webChat || webCode ? true : undefined}
          label={formatText("More options for {label}", {
            label: c.title.trim(),
          })}
          entries={entries}
          position={menu}
          // The Keep computer awake row (its line under the label and its
          // switch) needs more room than the captured 160.
          width={nativeChat || webCode ? "max-content" : menuWidth}
          anchors={[trigger]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

/**
 * The same items as the conversation's sidebar menu: Code keeps Archive, Chat
 * and Cowork move between projects — "Change project" once the conversation
 * already belongs to one.
 */
export function titleMenuEntries(
  c: Conversation,
  projects: Project[],
  running: boolean,
  actions: Omit<TitleActions, "onRename"> & { onRename: () => void },
): MenuEntry[] {
  const webChat = surface === "web" && c.mode !== "code";
  const chat = c.mode !== "code";
  const iconSize = webChat ? 20 : 16;
  const pin: MenuEntry = {
    label: c.pinned ? "Unpin" : "Pin",
    ...(chat
      ? {
          icon: (
            <AppIcon name={c.pinned ? "PinSlash" : "Pin"} size={iconSize} />
          ),
        }
      : {}),
    hint: "P",
    onSelect: actions.onPin,
  };
  const rename: MenuEntry = {
    label: "Rename",
    ...(chat ? { icon: <AppIcon name="Edit" size={iconSize} /> } : {}),
    hint: "R",
    onSelect: actions.onRename,
  };
  // A running conversation cannot be deleted, as in the header menu before.
  const removeEntry: MenuEntry = {
    label: "Delete",
    ...(chat ? { icon: <AppIcon name="Trash" size={iconSize} /> } : {}),
    hint: "D",
    danger: true,
    disabled: running,
    onSelect: actions.onDelete,
  };
  if (c.mode === "code") {
    // Groups with a rule between them, in the order open (Open PR, Open in ▸),
    // edit (Rename, Fork), share (Copy link, Export), settings (Transcript
    // view, Output style, Keep computer awake) and remove (Archive, Delete).
    // The header's menu has no Pin (canPin false). Rows Claudex cannot act on
    // yet are greyed with the reason (UI first).
    const off = (label: string, title: string, hint?: string): MenuEntry => ({
      label,
      title,
      disabled: true,
      ...(hint ? { hint } : {}),
    });
    const openIn = codeOpenInEntries(actions);
    const open: MenuEntry[] = [
      ...(actions.onOpenPr
        ? [{ label: "Open PR", hint: "G", onSelect: actions.onOpenPr }]
        : []),
      ...(openIn.length ? [{ label: "Open in", submenu: openIn }] : []),
      // The original's session menu rows for the session's tasks.
      ...(actions.onSeeBackgroundTasks
        ? [
            {
              label: "See background tasks",
              onSelect: actions.onSeeBackgroundTasks,
            },
          ]
        : []),
      ...(actions.onClearBackgroundTasks
        ? [
            {
              label: "Clear background tasks",
              onSelect: actions.onClearBackgroundTasks,
            },
          ]
        : []),
    ];
    // A web session is a cloud one: no Fork, Export or Output style, which are
    // a local session's; Edit cloud environment instead.
    const cloud = surface === "web";
    const edit: MenuEntry[] = [
      rename,
      ...(cloud
        ? []
        : [
            actions.onFork
              ? { label: "Fork", hint: "F", onSelect: actions.onFork }
              : off(
                  "Fork",
                  actions.forkDisabledReason ?? codeMenuReasons.fork,
                  "F",
                ),
          ]),
    ];
    const share: MenuEntry[] = [
      ...(actions.onCopyLink
        ? [{ label: "Copy link", hint: "C", onSelect: actions.onCopyLink }]
        : []),
      ...(!cloud && actions.onExport && !c.incognito
        ? [{ label: "Export", hint: "E", onSelect: actions.onExport }]
        : []),
    ];
    const settings: MenuEntry[] = [
      {
        label: "Transcript view",
        submenu: actions.transcriptView
          ? transcriptViewEntries(actions.transcriptView)
          : [
              { label: "Normal", checked: true, onSelect: () => {} },
              off("Thinking", codeMenuReasons.transcript),
              off("Verbose", codeMenuReasons.transcript),
            ],
      },
      ...(cloud && actions.onEditEnvironment
        ? [
            {
              label: "Edit cloud environment",
              onSelect: actions.onEditEnvironment,
            },
          ]
        : []),
      ...(cloud ? [] : [outputStyleRow(c, actions, off)]),
      ...(actions.keepAwake && !c.archived
        ? [
            {
              label: "Keep computer awake",
              description: "Only for this session",
              switched: actions.keepAwake.on,
              keepOpen: true,
              onSelect: actions.keepAwake.onToggle,
            },
          ]
        : []),
    ];
    const remove: MenuEntry[] = [
      {
        label: c.archived ? "Unarchive" : "Archive",
        hint: "A",
        onSelect: actions.onArchive,
      },
      { ...removeEntry },
    ];
    return [open, edit, share, settings, remove]
      .filter((group) => group.length)
      .flatMap((group, index) =>
        index ? [{ separator: true as const }, ...group] : group,
      );
  }
  return [
    pin,
    // Pin, Mark as unread, Rename, Add to project, Move to group, a rule and
    // Delete. An incognito chat is never kept, so it is not marked, grouped or
    // put in a project.
    ...(actions.onToggleUnread && !c.incognito
      ? [
          {
            label: c.unread ? "Mark as read" : "Mark as unread",
            hint: "U",
            icon: (
              <AppIcon name={c.unread ? "Eye" : "EyeSlash"} size={iconSize} />
            ),
            onSelect: actions.onToggleUnread,
          },
        ]
      : []),
    rename,
    // The chat menu's project rows.
    ...(c.incognito
      ? []
      : projectEntries(c, projects, {
          moveToProject: actions.onMoveToProject,
          newProject: (name) => actions.onCreateProject(name || undefined),
        }).map((entry) =>
          "label" in entry && entry.label !== "Remove from project"
            ? {
                ...entry,
                icon: <AppIcon name="Projects" size={iconSize} />,
              }
            : entry,
        )),
    ...(actions.moveToGroup && !c.incognito ? [actions.moveToGroup] : []),
    ...(actions.onShare
      ? [
          {
            label: "Share session",
            icon: <AppIcon name="Share" size={iconSize} />,
            onSelect: actions.onShare,
          },
        ]
      : []),
    // Native SO copies the current account route, never an export or a
    // newly-created public share (O16 shared-16:22729–22789). Claudex only
    // offers the host-supplied usable link; a local chat without one omits it.
    ...(surface !== "web" && actions.onCopyLink
      ? [
          {
            label: "Copy link",
            icon: <AppIcon name="Link" size={16} />,
            onSelect: actions.onCopyLink,
          },
        ]
      : []),
    { separator: true },
    removeEntry,
  ];
}

/**
 * Transcript view ▸: the three views as radio rows, then, while the session
 * shows a view other than the default, a rule and "Make {mode} the default".
 */
export function transcriptViewEntries(menu: TranscriptViewMenu): MenuEntry[] {
  const rows: MenuEntry[] = transcriptViews.map((view) => ({
    label: transcriptViewLabels[view],
    checked: menu.view === view,
    onSelect: () => {
      if (view !== menu.view) menu.onSelect(view);
    },
  }));
  if (menu.view === menu.defaultView) return rows;
  return [
    ...rows,
    { separator: true },
    {
      label: `Make ${transcriptViewLabels[menu.view]} the default`,
      onSelect: menu.onMakeDefault,
    },
  ];
}

/** Output style ▸ in a local Code session's title menu. */
function outputStyleRow(
  c: Conversation,
  actions: Pick<TitleActions, "outputStyle" | "onNewOutputStyle">,
  off: (label: string, title: string, hint?: string) => MenuEntry,
): MenuEntry {
  return {
    label: "Output style",
    submenu: [
      ...(
        actions.outputStyle ??
        builtInOutputStyleNames.map((name) => ({
          name,
          onSelect: () => {},
        }))
      ).map((style) => ({
        label: style.name === "default" ? "Default" : style.name,
        checked:
          c.outputStyle === style.name ||
          (!c.outputStyle && style.name === "default"),
        onSelect: style.onSelect,
      })),
      { separator: true },
      ...(actions.onNewOutputStyle
        ? [{ label: "New style…", onSelect: actions.onNewOutputStyle }]
        : [off("New style…", codeMenuReasons.outputStyle)]),
    ],
  };
}

/**
 * Open in ▸ for a Code session: Split view and New window; then, under "Open
 * in", the installed editors, Terminal and the file manager; then, under
 * "Continue in", Cloud. The headings show only when Continue in has a row;
 * rules sit between the sections, and the first nine rows take the keys 1 to 9.
 */
export function codeOpenInEntries(
  actions: Pick<
    TitleActions,
    | "onOpenInSplit"
    | "onOpenInWindow"
    | "editors"
    | "onOpenTerminal"
    | "onRevealFolder"
    | "fileManager"
    | "onContinueInCloud"
    | "onOpenInDesktop"
  >,
): MenuEntry[] {
  type Row = {
    label: string;
    onSelect: () => void;
    description?: string;
    noTranslate?: boolean;
  };
  const layout: Row[] = [
    ...(actions.onOpenInSplit
      ? [{ label: "Split view", onSelect: actions.onOpenInSplit }]
      : []),
    ...(actions.onOpenInWindow
      ? [{ label: "New window", onSelect: actions.onOpenInWindow }]
      : []),
  ];
  const openIn: Row[] = [
    ...(actions.editors ?? []).map((editor) => ({
      label: editor.name,
      noTranslate: true,
      onSelect: editor.onSelect,
    })),
    ...(actions.onOpenTerminal
      ? [{ label: "Terminal", onSelect: actions.onOpenTerminal }]
      : []),
    ...(actions.onOpenInDesktop
      ? [{ label: "Desktop app", onSelect: actions.onOpenInDesktop }]
      : []),
    ...(actions.onRevealFolder
      ? [
          {
            label: actions.fileManager ?? "Finder",
            onSelect: actions.onRevealFolder,
          },
        ]
      : []),
  ];
  const continueIn: Row[] = actions.onContinueInCloud
    ? [
        {
          label: "Cloud",
          description: "Runs without your computer",
          onSelect: actions.onContinueInCloud,
        },
      ]
    : [];
  const headed = continueIn.length > 0;
  let number = 0;
  const sections = [
    { heading: undefined, rows: layout },
    { heading: headed ? "Open in" : undefined, rows: openIn },
    { heading: headed ? "Continue in" : undefined, rows: continueIn },
  ].filter((section) => section.rows.length);
  return sections.flatMap((section, index) => [
    ...(index ? [{ separator: true as const }] : []),
    ...(section.heading ? [{ heading: section.heading }] : []),
    ...section.rows.map((row) => {
      number += 1;
      return {
        label: row.label,
        ...(row.noTranslate ? { noTranslate: true } : {}),
        ...(row.description && headed ? { description: row.description } : {}),
        ...(number <= 9 ? { hint: String(number) } : {}),
        onSelect: row.onSelect,
      };
    }),
  ]);
}
