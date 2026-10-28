import { useContext, useEffect, useState, type RefObject } from "react";
import { AppContext } from "../app/AppContext";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { Menu, type MenuPosition, type MenuEntry } from "../ui/Menu";
import { NavTemplateIcon } from "./NavCreateMenu";
import { createBlankArtifact } from "../artifacts/create-blank-artifact";
import { startCodeTemplate } from "../artifacts/start-code-template";
import type { ArtifactOutputKind } from "../../shared/artifact-output";
import { AppIcon } from "../ui/app-icon";
import { useHost } from "../host/HostContext";
import { useT } from "../i18n";
import {
  createScheduledChat,
  scheduledChatPrompt,
} from "./create-scheduled-chat";
export function NavCreatePopup({
  kind,
  position,
  anchor,
  onClose,
}: {
  kind: "artifacts" | "scheduled";
  position: MenuPosition;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const app = useContext(AppContext);
  const host = useHost();
  const t = useT();
  // The chat setup is offered while the scheduler may start it; once it says
  // it cannot, the page's own menu hides it too (routine-menus.tsx).
  const [setupWithChat, setSetupWithChat] = useState<boolean>();
  useEffect(() => {
    if (kind !== "scheduled") return;
    let current = true;
    const owner = window.desktop;
    Promise.resolve()
      .then(() => owner?.routineCapabilities?.())
      .then((value) => {
        if (current && value) setSetupWithChat(value.setupWithChat === true);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [kind]);
  const label = kind === "artifacts" ? "New from a template" : "New task";
  const width = kind === "artifacts" ? 240 : 183;
  const closePhoneSidebar = () => {
    if (app?.sidebarView.phone && app.sidebarView.open)
      app.sidebarView.toggle();
  };
  const template = (output: ArtifactOutputKind) => {
    closePhoneSidebar();
    if (app && startCodeTemplate(app, output)) return;
    if (app) void createBlankArtifact(app, output);
  };
  const schedule = () => {
    closePhoneSidebar();
    requestScheduleConfirmation({
      description: "",
      blank: true,
    });
    app?.setPage("scheduled");
  };
  const entries: MenuEntry[] =
    kind === "artifacts"
      ? [
          {
            label: "Docs",
            badge: "New",
            badgeInline: true,
            icon: <NavTemplateIcon kind="Docs" />,
            onSelect: () => template("docs"),
          },
          {
            label: "Slides",
            badge: "New",
            badgeInline: true,
            icon: <NavTemplateIcon kind="Slides" />,
            onSelect: () => template("slides"),
          },
          {
            label: "Design",
            badge: "New",
            badgeInline: true,
            icon: <NavTemplateIcon kind="Design" />,
            onSelect: () => template("design"),
          },
          { separator: true },
          {
            label: "Dashboard",
            badge: "Beta",
            badgeInline: true,
            icon: <NavTemplateIcon kind="Dashboard" />,
            onSelect: () => template("dashboard"),
          },
          { separator: true },
          {
            heading:
              app?.mode === "code"
                ? "Opens a new session ready to make what you pick. Nothing is created until you send."
                : "Creates a blank artifact with Claudex on the side.",
          },
        ]
      : [
          ...(setupWithChat === false
            ? []
            : [
                {
                  label: "Create with Claudex",
                  icon: (
                    <AppIcon name="Chat" size={host.kind === "web" ? 20 : 16} />
                  ),
                  onSelect: () => {
                    closePhoneSidebar();
                    if (app) createScheduledChat(app, t(scheduledChatPrompt));
                  },
                },
              ]),
          {
            label: "Set up manually",
            icon: (
              <AppIcon name="Settings" size={host.kind === "web" ? 20 : 16} />
            ),
            onSelect: schedule,
          },
        ];
  return (
    <Menu
      label={label}
      position={position}
      width={width}
      className={`nav-create-menu ${kind}`}
      entries={entries}
      anchors={[anchor]}
      onClose={onClose}
    />
  );
}
