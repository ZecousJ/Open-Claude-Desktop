import { IconButton } from "../../ui/Controls";
import { PageSearchIcon } from "../../ui/icons";
import { X, ArrowUpDown, Pin, EllipsisVertical } from "../../ui/glyphs";
import { ProjectReadState } from "./ProjectReadState";
import { t, formatText } from "../../i18n";
import { ProjectCardFooter } from "./ProjectCardFooter";
import { projectCardTime } from "./project-list";
import { EmptyState } from "../../ui/EmptyState";
import { projectTemplates } from "../../dialogs/project-templates";
import type { Conversation, Project } from "../../../shared/types";
import type { OpenMenu } from "./ProjectsPage";
import type { ProjectView, ProjectSort } from "./project-list";
import type { HostInfo } from "../../../shared/host";
import type { ProjectCreationCapabilities } from "../../../shared/project-access";
import type { SettingsRequestScope } from "../../settings/useSettingsRequestScope";
import type { ProjectCatalogRead } from "../../composer/useProjectCatalogState";

/** What projectsPageView needs from ProjectsPage.tsx. */
export interface ProjectsPageViewKit {
  anyArchived: boolean;
  column: React.RefObject<HTMLDivElement | null>;
  conversations: Conversation[];
  detailsDialog: React.JSX.Element | undefined;
  grid: React.RefObject<HTMLDivElement | null>;
  grouped: boolean;
  groupingAvailable: boolean;
  groups: { label: string; projects: Project[] }[];
  host: HostInfo;
  keys: {
    onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void;
    onResultsKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
  };
  menu: OpenMenu | undefined;
  onNewProject: (
    template?:
      | {
          readonly title: "Study project";
          readonly summary: "Learn and master any subject";
          readonly heading: "Create a study project";
          readonly question: "What course are you studying?";
          readonly description: "A project for studying your course materials, where Claudex helps visualize key concepts, build comprehensive study guides, and tutor you according to your learning needs.";
        }
      | {
          readonly title: "Career project";
          readonly summary: "Find the next step for your career";
          readonly heading: "Create a career project";
          readonly question: "What are you working towards?";
          readonly description: "A project for exploring career opportunities, where Claudex helps match your skills to potential careers, improve your resume, and develop personalized roadmaps for professional growth.";
        }
      | {
          readonly title: "Research project";
          readonly summary: "Analyze and organize research";
          readonly heading: "Create a research project";
          readonly question: "What are you researching?";
          readonly description: "A project for developing academic research, where Claudex helps identify key themes in your research, create structured outlines, and provide feedback to improve your drafts.";
        }
      | undefined,
  ) => void;
  onSaveProject: (project: Project) => Promise<void>;
  pageMenu: React.JSX.Element | undefined;
  projectCreation: {
    status: "ready" | "failed" | "pending";
    capabilities: ProjectCreationCapabilities | undefined;
    retry: () => void;
    capture: () => SettingsRequestScope;
    key: number;
  };
  projectMenu: (
    project: Project,
    anchor: HTMLElement,
    onMemory?: (() => void) | undefined,
  ) => void;
  projectRead: ProjectCatalogRead;
  query: string;
  rows: Project[];
  searchInput: React.RefObject<HTMLInputElement | null>;
  searching: boolean;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setOpenId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setQuery: (value: string | null) => void;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setView: (value: ProjectView) => void;
  sort: ProjectSort;
  sortAnchor: React.RefObject<HTMLSpanElement | null>;
  tab: ProjectView;
  wide: boolean;
}

export function projectsPageView(kit: ProjectsPageViewKit) {
  const {
    anyArchived,
    column,
    conversations,
    detailsDialog,
    grid,
    grouped,
    groupingAvailable,
    groups,
    host,
    keys,
    menu,
    onNewProject,
    onSaveProject,
    pageMenu,
    projectCreation,
    projectMenu,
    projectRead,
    query,
    rows,
    searchInput,
    searching,
    setMenu,
    setOpenId,
    setQuery,
    setSearchOpen,
    setView,
    sort,
    sortAnchor,
    tab,
    wide,
  } = kit;
  const projectsPageViewView = (
    <div className="prj-view">
      <div className="prj-column" ref={column}>
        <header className="prj-head">
          <h1>Projects</h1>
          <div className="prj-tools">
            {!searching && !wide ? (
              <IconButton
                label="Search projects"
                className="prj-icon"
                onClick={() => setSearchOpen(true)}
              >
                <PageSearchIcon size={20} />
              </IconButton>
            ) : (
              <label className={`prj-search ${wide ? "wide" : ""}`}>
                <PageSearchIcon size={14} />
                <input
                  ref={searchInput}
                  aria-label="Search projects"
                  placeholder="Search projects..."
                  value={query ?? ""}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-describedby="prj-search-hint"
                  onKeyDown={keys.onInputKeyDown}
                />
                <span id="prj-search-hint" className="sr-only">
                  Results update as you type. Press Down Arrow to go to results,
                  Escape to return here.
                </span>
                {(!wide || Boolean(query)) && (
                  <button
                    type="button"
                    aria-label={wide ? "Clear search" : "Close search"}
                    onClick={() => setQuery(null)}
                  >
                    <X size={16} strokeWidth={1.6} />
                  </button>
                )}
              </label>
            )}
            <span ref={sortAnchor} className="prj-anchor">
              <IconButton
                label="Sort projects"
                className="prj-icon"
                menu
                expanded={menu?.kind === "sort"}
                onClick={() =>
                  setMenu(menu?.kind === "sort" ? undefined : { kind: "sort" })
                }
              >
                <ArrowUpDown size={20} strokeWidth={1.5} />
              </IconButton>
            </span>
            <button
              type="button"
              className="prj-new"
              onClick={() => onNewProject()}
            >
              New project
            </button>
          </div>
        </header>
        {anyArchived && (
          <div className="prj-tabs" role="tablist" aria-label="Filter projects">
            {(["mine", "archived"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setView(value)}
              >
                {value === "mine" ? "Your projects" : "Archived"}
              </button>
            ))}
          </div>
        )}
        <ProjectReadState read={projectRead} />
        {(projectRead.status === "ready" ||
          (projectRead.cached && rows.length > 0)) &&
          (rows.length ? (
            <div
              ref={grid}
              className="prj-groups"
              onKeyDown={keys.onResultsKeyDown}
            >
              {groups.map((group) => (
                <section key={group.label}>
                  {groupingAvailable &&
                    grouped &&
                    group.label !== "Projects" && (
                      <h3 className="prj-group-heading">
                        {group.label === "Local projects" ? "Local" : "Code"}
                      </h3>
                    )}
                  <ul className="prj-grid" aria-label={group.label}>
                    {group.projects.map((project) => {
                      const menuOpen =
                        menu?.kind === "project" &&
                        menu.project.id === project.id;
                      return (
                        <li
                          key={project.id}
                          role="listitem"
                          className={menuOpen ? "menu-open" : ""}
                        >
                          <div
                            className={`prj-card u-press-card${project.description ? " has-description" : ""}`}
                          >
                            <strong>
                              {host.kind === "web" ? (
                                <a
                                  className="prj-card-link"
                                  data-no-translate
                                  href={`/project/${encodeURIComponent(project.id)}`}
                                  data-primary=""
                                  onClick={(event) => {
                                    if (
                                      event.button !== 0 ||
                                      event.metaKey ||
                                      event.ctrlKey ||
                                      event.shiftKey ||
                                      event.altKey
                                    )
                                      return;
                                    event.preventDefault();
                                    setOpenId(project.id);
                                  }}
                                >
                                  {project.name}
                                </a>
                              ) : (
                                <button
                                  className="prj-card-link"
                                  data-no-translate
                                  type="button"
                                  data-primary=""
                                  onClick={() => setOpenId(project.id)}
                                >
                                  {project.name}
                                </button>
                              )}
                              {project.pinned && (
                                <button
                                  className="prj-card-pin"
                                  type="button"
                                  aria-label={t("Unpin project")}
                                  onClick={() =>
                                    void onSaveProject({
                                      ...project,
                                      pinned: false,
                                    })
                                  }
                                >
                                  <Pin size={16} strokeWidth={1.6} />
                                </button>
                              )}
                              {project.isStarterProject && (
                                <span className="prj-card-example">
                                  {t("Example project")}
                                </span>
                              )}
                            </strong>
                            {project.description && (
                              <span data-no-translate>
                                {project.description}
                              </span>
                            )}
                            <ProjectCardFooter
                              project={project}
                              timestamp={projectCardTime(
                                project,
                                conversations,
                                sort,
                              )}
                            />
                          </div>
                          <button
                            type="button"
                            className="prj-card-more"
                            data-no-translate
                            aria-label={formatText("More options for {title}", {
                              title: project.name,
                            })}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={(event) =>
                              projectMenu(project, event.currentTarget)
                            }
                          >
                            <EllipsisVertical size={20} strokeWidth={1.6} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : query?.trim() ? (
            // The original's no-match line: mt-10 text-center text-body
            // text-muted.
            <p className="prj-none">
              {formatText("No projects matching “{query}”", {
                query: query.trim(),
              })}
            </p>
          ) : (
            <EmptyState
              pictogram="HandBlocks"
              headline="Looking to start a project?"
              description="Give Claudex a folder you already work from"
              ctaLabel="New project"
              onCtaClick={() => onNewProject()}
            />
          ))}
      </div>
      {projectRead.status === "ready" &&
        projectCreation.capabilities?.educationSuggestions === true &&
        host.kind === "web" &&
        !query?.trim() &&
        tab === "mine" && (
          <section className="prj-template-section prj-column">
            <h2>
              {t("Set up Claudex for your classes, career, and research")}
            </h2>
            <div className="prj-template-cards">
              {projectTemplates.map((template) => (
                <button
                  type="button"
                  key={template.title}
                  onClick={() => onNewProject(template)}
                >
                  <h3>{t(template.title)}</h3>
                  <p>{t(template.summary)}</p>
                </button>
              ))}
            </div>
          </section>
        )}
      {detailsDialog}
      {pageMenu}
    </div>
  );
  return projectsPageViewView;
}
