import {
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Conversation } from "../../../shared/types";
import type { SharingStatus } from "../../../shared/sharing-api";
import { AppContext } from "../../app/AppContext";
import { Menu, type MenuEntry } from "../../ui/Menu";
import { projectEntries } from "../../sidebar/project-entries";
import { lazyPiece } from "../../ui/lazy-piece";
import { Pencil, Pin, Trash2 } from "../../ui/glyphs";
import "../../conversation/conversation-share.css";

const ConversationShareDialog = lazyPiece(
  () => import("../../conversation/ConversationShareDialog"),
  "ConversationShareDialog",
);

/** Reuse controller mutations, the project submenu and the sharing dialog.
 * A retained menu must resolve its record from the current owner's snapshot. */
export function ProjectChatActions({
  conversation,
  anchor,
  label,
  onClose,
}: {
  conversation: Conversation;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose(): void;
}) {
  const app = useContext(AppContext)!;
  const bridge = window.desktop;
  const scope = useMemo(
    () => ({ active: true, app, bridge }),
    [app.accountId, app.controllerScope, bridge],
  );
  const latest = useRef(scope);
  latest.current = scope;
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const owner = (allowClosed = false) => {
    if (
      (!allowClosed && !scope.active) ||
      latest.current !== scope ||
      window.desktop !== bridge
    )
      return;
    const current = app.currentController ? app.currentController.current : app;
    if (
      !current ||
      current.accountId !== app.accountId ||
      current.controllerScope !== app.controllerScope
    )
      return;
    return current;
  };
  const current = (allowClosed = false) => {
    const controller = owner(allowClosed);
    const row = (
      controller?.latest?.current ?? controller?.snapshot
    )?.conversations.find((c) => c.id === conversation.id);
    return row && !row.incognito && row.projectId === conversation.projectId
      ? { controller: controller!, row }
      : undefined;
  };
  const run = (
    action: (value: NonNullable<ReturnType<typeof current>>) => void,
  ) => {
    const value = current();
    if (value) action(value);
  };
  const patch = (
    value: NonNullable<ReturnType<typeof current>>,
    change: Parameters<typeof app.patchConversation>[1],
  ) =>
    void value.controller
      .patchConversation(value.row, change)
      .catch((error) => owner(true)?.report(error));
  const [sharing, setSharing] = useState<{
    scope: typeof scope;
    status: SharingStatus;
    link?: string;
  }>();
  const [shareOpen, setShareOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!current() || !bridge.sharingStatus) return;
    void bridge
      .sharingStatus()
      .then(async (status) => {
        if (!alive || !current() || !status) return;
        const link = await bridge
          .conversationShare(conversation.id)
          .catch(() => null);
        if (alive && current())
          setSharing({
            scope,
            status,
            link: link?.status === "active" ? link.url : undefined,
          });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [scope, conversation.id]);
  const value = current();
  if (!value) return null;
  const { row, controller } = value;
  const share = sharing?.scope === scope ? sharing : undefined;
  const entries: MenuEntry[] = [
    {
      label: row.pinned ? "Unpin" : "Pin",
      hint: "P",
      icon: <Pin size={20} strokeWidth={1.5} />,
      onSelect: () => run((v) => patch(v, { pinned: !v.row.pinned })),
    },
    {
      label: "Rename",
      hint: "R",
      icon: <Pencil size={20} strokeWidth={1.5} />,
      onSelect: () =>
        run((v) =>
          v.controller.setRename({ id: v.row.id, title: v.row.title }),
        ),
    },
    ...projectEntries(
      row,
      (controller.latest?.current ?? controller.snapshot).projects,
      {
        moveToProject: (projectId) =>
          run((v) => {
            const project = (
              v.controller.latest?.current ?? v.controller.snapshot
            ).projects.find((p) => p.id === projectId);
            if (projectId && !project) return;
            void bridge
              .updateConversation(v.row.id, { projectId })
              .then((updated) => {
                const accepted = current(true);
                if (!accepted) return;
                const live = accepted.controller;
                live.upsert(updated);
                if (live.activeId === v.row.id) {
                  live.setProjectId(projectId ?? undefined);
                  if (project?.cwd) live.setCwd(project.cwd);
                }
              })
              .catch((error) => owner(true)?.report(error));
          }),
        newProject: (name) =>
          run((v) => v.controller.startProject(v.row.id, name)),
      },
    ),
    ...(share?.status.conversations
      ? [
          {
            label: "Share",
            keepOpen: true,
            onSelect: () => run(() => setShareOpen(true)),
          },
        ]
      : []),
    ...(share?.link
      ? [
          {
            label: "Copy link",
            hint: "C",
            onSelect: () =>
              run((v) => {
                void bridge
                  .conversationShare(v.row.id)
                  .then((link) => {
                    if (current(true) && link?.status === "active")
                      return bridge.copyText(link.url);
                  })
                  .catch((error) => owner(true)?.report(error));
              }),
          },
        ]
      : []),
    ...(row.mode === "cowork" || row.mode === "code" || row.archived
      ? [
          {
            label: row.archived ? "Unarchive" : "Archive",
            onSelect: () => run((v) => patch(v, { archived: !v.row.archived })),
          },
        ]
      : []),
    { separator: true },
    {
      label: "Delete",
      hint: "D",
      icon: <Trash2 size={20} strokeWidth={1.5} />,
      danger: true,
      onSelect: () => run((v) => v.controller.confirmDelete(v.row)),
    },
  ];
  return shareOpen && share ? (
    <Suspense fallback={null}>
      <ConversationShareDialog
        conversation={row}
        status={share.status}
        onClose={onClose}
      />
    </Suspense>
  ) : (
    <Menu
      label={label}
      entries={entries}
      width="max-content"
      showRootHints
      position={
        anchor.current
          ? {
              left: anchor.current.getBoundingClientRect().left,
              top: anchor.current.getBoundingClientRect().bottom + 4,
            }
          : { left: 0, top: 0 }
      }
      anchors={[anchor]}
      onClose={onClose}
    />
  );
}
