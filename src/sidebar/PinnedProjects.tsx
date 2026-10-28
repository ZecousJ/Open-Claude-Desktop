import { useRef, useState, type ReactNode } from "react";
import { surface } from "../../shared/host";
import type { Conversation, Project } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { requestProject } from "../collections/open-requests";
import { api } from "../desktop-api";
import { formatText } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import { formatWebRoute } from "../web/routes";

export function PinnedProjects({
  projects,
  conversations,
  renderConversation,
}: {
  projects: Project[];
  conversations: Conversation[];
  renderConversation: (conversation: Conversation) => ReactNode;
}) {
  return projects.map((project) => (
    <PinnedProject
      key={project.id}
      project={project}
      conversations={conversations}
      renderConversation={renderConversation}
    />
  ));
}

function PinnedProject({
  project,
  conversations,
  renderConversation,
}: {
  project: Project;
  conversations: Conversation[];
  renderConversation: (conversation: Conversation) => ReactNode;
}) {
  const app = useApp();
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  const Row = surface === "web" ? "a" : "button";
  const open = () => {
    requestProject(project.id);
    app.setPage("projects");
  };
  const updatePin = async () => {
    const saved = await api.saveProject({ ...project, pinned: false });
    app.setSnapshot(
      (snapshot) =>
        snapshot && {
          ...snapshot,
          projects: snapshot.projects.map((item) =>
            item.id === saved.id ? saved : item,
          ),
        },
    );
  };
  const children = conversations
    .filter(
      (c) =>
        c.projectId === project.id &&
        c.mode !== "code" &&
        !c.archived &&
        !c.incognito,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="pinned-project" data-project-id={project.id}>
      <div className="conversation-row" data-roving-row="">
        <Row
          className="conversation-link"
          data-roving-item=""
          href={
            surface === "web"
              ? formatWebRoute({ kind: "project", id: project.id })
              : undefined
          }
          onClick={(event) => {
            if (
              surface === "web" &&
              (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            )
              return;
            event.preventDefault();
            open();
          }}
        >
          <AppIcon name="Projects" size={16} />
          <span className="row-title-slot" data-no-translate>
            {project.name}
          </span>
        </Row>
        <button
          className="project-sessions-toggle"
          aria-label={formatText("Toggle sessions for {name}", {
            name: project.name,
          })}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <AppIcon name={expanded ? "CaretDown" : "CaretRight"} size={12} />
        </button>
        <button
          ref={anchor}
          className="row-more"
          aria-label={formatText("More options for {title}", {
            title: project.name,
          })}
          aria-haspopup="menu"
          aria-expanded={Boolean(position)}
          onClick={() => {
            const box = anchor.current!.getBoundingClientRect();
            setPosition(
              position ? undefined : { left: box.right + 4, top: box.top },
            );
          }}
        >
          <AppIcon name="DotsVertical" size={16} />
        </button>
      </div>
      {expanded && (
        <div className="pinned-project-sessions">
          {children.map(renderConversation)}
        </div>
      )}
      {position && (
        <Menu
          label={formatText("More options for {title}", {
            title: project.name,
          })}
          position={position}
          width={200}
          anchors={[anchor]}
          onClose={() => setPosition(undefined)}
          entries={[
            {
              label: "Unpin",
              onSelect: () => void updatePin().catch(app.report),
            },
            {
              label: "Edit details",
              onSelect: () => app.setProjectEditor(project),
            },
            { separator: true },
            {
              label: "Archive",
              onSelect: () =>
                void import("../app/CollectionPages")
                  .then(({ confirmArchiveProject }) =>
                    confirmArchiveProject(app, project),
                  )
                  .catch(app.report),
            },
            {
              label: "Delete",
              danger: true,
              onSelect: () =>
                void import("../app/CollectionPages")
                  .then(({ confirmDeleteProject }) =>
                    confirmDeleteProject(app, project),
                  )
                  .catch(app.report),
            },
          ]}
        />
      )}
    </div>
  );
}
