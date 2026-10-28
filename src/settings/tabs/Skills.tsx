import { useRef, useState } from "react";
import { Video } from "lucide-react";
import {
  ArrowUpDown,
  MessageCircleMore,
  Pencil,
  Upload,
  ChevronDown,
  Plus,
  Search,
} from "../../ui/glyphs";
import { PageMenu, type PageMenuEntry } from "../../collections/PageMenu";
import { IconButton } from "../../ui/Controls";
import { Pictogram } from "../../ui/Pictogram";
import { PageFilterIcon } from "../../ui/icons";
import { PageHeader, Segmented } from "../controls";
import { discoverSortLabels } from "../../collections/customize/CustomizeDirectory";
import {
  type SkillOrigin,
  type SkillSort,
} from "../../collections/customize/customize-list";
import type { PluginEntry } from "../../../shared/collections-api";
import { PluginsBody } from "../../plugins/PluginsBody";
import { AddMarketplaceDialog } from "../../plugins/AddMarketplaceDialog";
import { PluginDetailDialog } from "../../plugins/PluginDetailDialog";
import { pluginCategoriesOf } from "../../plugins/plugin-model";
import { usePlugins } from "../../plugins/usePlugins";
import { useApprovedDirectory } from "../../plugins/useApprovedDirectory";
import { useTryPluginChat } from "../../plugins/try-plugin-chat";
import { SkillPage } from "./SkillPage";
import { UploadSkillPage } from "../../collections/customize/UploadSkillPage";
import { notAvailable } from "../unavailable";
import { CreateSkillDialog } from "../../collections/customize/CreateSkillDialog";
import { SkillNameDialog } from "../../collections/customize/NameCopyDialog";
import { renamedSkillPath } from "../../../shared/duplicate-name";
import type { TabProps } from "../context";
import { useLoaded } from "../pageControls";
import { useHostCapability } from "../../host/HostContext";
import { groupSkills, skillOrigin, type ListedSkill } from "./desktop-labels";
import "../desktop.css";
import "../directory/directory.css";
import "../../collections/customize/customize.css";
import { SkillRow } from "./SkillRow";
import { skillMenu, RemoveSkill } from "./SkillRow";

/** Rows Settings search finds on this page. */
export { skillsLabels as searchLabels } from "./desktop-labels";

/**
 * Skills: what the agent runtime has loaded, grouped by source. Add creates a
 * skill or uploads a folder with a SKILL.md; each row's menu turns it on or
 * off, shows it in its folder, and deletes the skills you added. Discover lists
 * the marketplaces' plugins as Customize → Discover does, with the Claudex
 * directory's curated blocks.
 */
export function SkillsTab({
  onError,
  skillsView,
  onSkillsViewChange,
}: TabProps) {
  // Uploading a folder and Show in folder need folders on this computer.
  const folders = useHostCapability("localFolders");
  const listed = useLoaded<{ skills?: ListedSkill[] }[]>(
    () => window.desktop.listSkills(),
    onError,
  );
  // When each SKILL.md last changed (the date on a row, Sort by Last edited).
  const dates = useLoaded<{ path: string; editedAt?: number }[]>(
    () => window.desktop.customizeSkills(),
    () => {},
  );
  const edited = new Map(
    (dates.value ?? []).map((skill) => [skill.path, skill.editedAt]),
  );
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<SkillOrigin>("all");
  const [sort, setSort] = useState<SkillSort>("edited");
  const [category, setCategory] = useState<string>();
  const [marketplace, setMarketplace] = useState<string>();
  const [menu, setMenu] = useState<"filter" | "sort">();
  const filterButton = useRef<HTMLSpanElement>(null);
  const sortButton = useRef<HTMLSpanElement>(null);
  const [add, setAdd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [localView, setLocalView] = useState<"yours" | "discover">("yours");
  const view = skillsView ?? localView;
  const setView = (next: "yours" | "discover") => {
    setLocalView(next);
    onSkillsViewChange?.(next);
  };
  const plugins = usePlugins(view === "discover");
  const directory = useApprovedDirectory(view === "discover");
  const [detail, setDetail] = useState<PluginEntry>();
  const [addingMarketplace, setAddingMarketplace] = useState(false);
  const tryPlugin = useTryPluginChat({
    onError,
    routeKey: JSON.stringify({ view, query, category, marketplace }),
  });
  // A skill's own page: replaces the list until Your skills.
  const [openPath, setOpenPath] = useState<string>();
  const [removing, setRemoving] = useState<ListedSkill>();
  // Duplicate or Rename.
  const [naming, setNaming] = useState<{
    kind: "duplicate" | "rename";
    skill: ListedSkill;
  }>();
  const addButton = useRef<HTMLButtonElement>(null);
  const run = (action: () => Promise<unknown>) =>
    void action()
      .then(() => listed.reload())
      .catch(onError);
  // Upload skill opens the Upload a skill page.
  const [uploading, setUploading] = useState(false);
  const upload = () => setUploading(true);
  const groups = groupSkills(listed.value ?? [], query)
    .map((group) => ({
      ...group,
      skills: group.skills
        .filter(
          (skill) => origin === "all" || skillOrigin(skill.scope) === origin,
        )
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name)
            : (edited.get(b.path) ?? 0) - (edited.get(a.path) ?? 0) ||
              a.name.localeCompare(b.name),
        ),
    }))
    .filter((group) => group.skills.length);
  const empty = listed.value !== undefined && !groupSkills(listed.value).length;
  // The callout stays until the person has a skill of their own.
  const noneOwn =
    listed.value !== undefined &&
    !groupSkills(listed.value).some((group) => group.scope === "user");
  const openMenu = (kind: "filter" | "sort") => {
    setAdd(false);
    setMenu(menu === kind ? undefined : kind);
  };
  const menuEntries = (): PageMenuEntry[] => {
    if (menu === "sort")
      return view === "discover"
        ? [
            { heading: "Sort by" },
            ...(
              Object.keys(
                discoverSortLabels,
              ) as (keyof typeof discoverSortLabels)[]
            ).map((value) => ({
              label: discoverSortLabels[value],
              checked: value === "name",
              disabled: value !== "name",
              title:
                value !== "name"
                  ? "This marketplace does not provide install counts or addition dates."
                  : undefined,
              onSelect: () => {},
            })),
          ]
        : [
            { heading: "Sort by" },
            ...(["edited", "name"] as const).map((value) => ({
              label: value === "edited" ? "Last edited" : "Name",
              checked: sort === value,
              onSelect: () => setSort(value),
            })),
          ];
    return view === "discover"
      ? [
          { heading: "Marketplace" },
          {
            label: "All marketplaces",
            checked: !marketplace,
            onSelect: () => setMarketplace(undefined),
          },
          ...(plugins.catalog?.marketplaces ?? []).map((item) => ({
            label: item.title ?? item.name,
            checked: marketplace === item.name,
            onSelect: () => setMarketplace(item.name),
          })),
          { separator: true },
          { heading: "Category" },
          {
            label: "All categories",
            checked: !category,
            onSelect: () => setCategory(undefined),
          },
          ...pluginCategoriesOf(plugins.catalog?.plugins ?? []).map((item) => ({
            label: item.label,
            checked: category === item.id,
            onSelect: () => setCategory(item.id),
          })),
        ]
      : [
          { heading: "Created by" },
          ...(
            [
              ["all", "All"],
              ["you", "You"],
              ["organization", "Your organization"],
              ["builtin", "Built in"],
            ] as const
          ).map(([value, label]) => ({
            label,
            checked: origin === value,
            onSelect: () => setOrigin(value),
          })),
        ];
  };
  const opened = openPath
    ? groupSkills(listed.value ?? [])
        .flatMap((group) => group.skills)
        .find((skill) => skill.path === openPath)
    : undefined;
  const nameDialog = naming && (
    <SkillNameDialog
      kind={naming.kind}
      skill={naming.skill}
      onDone={(name) => {
        // A renamed skill's page follows it to its new folder.
        if (naming.kind === "rename" && openPath === naming.skill.path)
          setOpenPath(renamedSkillPath(naming.skill.path, name));
        void listed.reload();
        void dates.reload();
      }}
      onClose={() => setNaming(undefined)}
    />
  );
  if (uploading)
    return (
      <div className="settings-list-page desktop-list">
        <UploadSkillPage
          onBack={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            setView("yours");
            void listed.reload();
          }}
        />
      </div>
    );
  if (opened)
    return (
      <div className="settings-list-page desktop-list">
        <SkillPage
          skill={opened}
          menuEntries={skillMenu(
            opened,
            folders,
            run,
            () => setRemoving(opened),
            (kind) => setNaming({ kind, skill: opened }),
          ).filter(
            (entry) => !("label" in entry && /^Turn /.test(entry.label)),
          )}
          onBack={() => setOpenPath(undefined)}
          onToggle={(enabled) =>
            window.desktop
              .setSkillEnabled(opened.path, enabled)
              .then(() => listed.reload())
          }
          onError={onError}
        />
        {nameDialog}
        {removing && (
          <RemoveSkill
            skill={removing}
            folders={folders}
            onDone={() => {
              setRemoving(undefined);
              setOpenPath(undefined);
              void listed.reload();
            }}
            onClose={() => setRemoving(undefined)}
            onError={onError}
          />
        )}
      </div>
    );
  return (
    <div className="settings-list-page desktop-list">
      <PageHeader title="Skills">
        <div className="directory-view-switch">
          <Segmented<"yours" | "discover">
            label="Skills view"
            value={view}
            options={[
              { value: "yours", label: "Yours" },
              { value: "discover", label: "Discover" },
            ]}
            onChange={setView}
          />
        </div>
        <label className="settings-page-search">
          <Search size={16} />
          <input
            placeholder="Search skills and plugins"
            aria-label="Search skills and plugins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="settings-page-tools">
          <span ref={filterButton} className="settings-page-anchor">
            <IconButton
              label="Filter skills"
              className={`settings-page-tool ${(view === "discover" ? Boolean(category || marketplace) : origin !== "all") ? "filtered" : ""}`}
              menu
              tooltip={false}
              expanded={menu === "filter"}
              onClick={() => openMenu("filter")}
            >
              <PageFilterIcon size={18} />
            </IconButton>
          </span>
          <span ref={sortButton} className="settings-page-anchor">
            <IconButton
              label="Sort skills"
              className="settings-page-tool"
              menu
              tooltip={false}
              expanded={menu === "sort"}
              onClick={() => openMenu("sort")}
            >
              <ArrowUpDown size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>
        <button
          ref={addButton}
          type="button"
          className="desktop-add-button"
          aria-haspopup="menu"
          aria-expanded={Boolean(add)}
          onClick={() => {
            setMenu(undefined);
            setAdd(!add);
          }}
        >
          <Plus size={16} strokeWidth={1.75} />
          Add
          <ChevronDown size={14} strokeWidth={1.75} />
        </button>
      </PageHeader>
      {menu && (
        <PageMenu
          label={menu === "filter" ? "Filter skills" : "Sort skills"}
          width={menu === "sort" ? 172 : 200}
          anchor={menu === "filter" ? filterButton : sortButton}
          onClose={() => setMenu(undefined)}
          entries={menuEntries()}
        />
      )}
      {add && (
        <PageMenu
          label="Add skill"
          width={184}
          anchor={addButton}
          onClose={() => setAdd(false)}
          entries={[
            // The original's four entries, in its order, with its icons.
            ...(folders
              ? [{ label: "Upload skill", icon: Upload, onSelect: upload }]
              : []),
            {
              label: "Create a skill",
              icon: Pencil,
              onSelect: () => setCreating(true),
            },
            {
              label: "Create with Claudex",
              icon: MessageCircleMore,
              disabled: true,
              title: notAvailable,
              onSelect: () => {},
            },
            {
              label: "Record your screen",
              icon: Video,
              disabled: true,
              title: notAvailable,
              onSelect: () => {},
            },
          ]}
        />
      )}
      {view === "discover" && (
        <PluginsBody
          view="discover"
          noun="skills"
          filter={{ query, category, marketplace, sort: "name" }}
          plugins={plugins}
          directory={directory}
          onUsePlugin={tryPlugin}
          onOpen={setDetail}
          onAddMarketplace={() => setAddingMarketplace(true)}
          onDiscover={() => setView("discover")}
          onError={onError}
        />
      )}
      {addingMarketplace && (
        <AddMarketplaceDialog
          plugins={plugins}
          onClose={() => setAddingMarketplace(false)}
          onAdded={() => setView("discover")}
        />
      )}
      {detail && (
        <PluginDetailDialog
          plugin={detail}
          plugins={plugins}
          onUsePlugin={tryPlugin}
          onClose={() => setDetail(undefined)}
          onError={onError}
        />
      )}
      {view === "yours" && noneOwn && !query.trim() && (
        // The callout of Customize → Yours, with Discover skills. The live card
        // is the one Customize → Yours shows: the 64px paper airplane.
        <section className="customize-callout customize-yours-callout">
          <div>
            <h3>Add your first skills</h3>
            <p>
              Skills teach Claudex how you work. Add them from Discover, or
              create your own.
            </p>
            <button type="button" onClick={() => setView("discover")}>
              Discover skills
            </button>
          </div>
          <Pictogram name="ObjectPaperAirplane" size={64} />
        </section>
      )}
      {view === "yours" && !empty && listed.value && !groups.length && (
        <p className="desktop-list-empty">No skills match your search</p>
      )}
      {(view === "yours" ? groups : []).map((group) => (
        <section key={group.scope} className="desktop-skill-group">
          <h2 className="settings-list-title">
            {group.title} <span>{group.skills.length}</span>
          </h2>
          <ul className="settings-list">
            {group.skills.map((skill) => (
              <SkillRow
                key={skill.path}
                skill={skill}
                edited={edited.get(skill.path)}
                folders={folders}
                run={run}
                onOpen={() => setOpenPath(skill.path)}
                onName={(kind) => setNaming({ kind, skill })}
                onError={onError}
              />
            ))}
          </ul>
        </section>
      ))}
      {nameDialog}
      {creating && (
        <CreateSkillDialog
          onClose={() => setCreating(false)}
          onCreate={async (skill) => {
            await window.desktop.saveSkill(skill);
            setCreating(false);
            void listed.reload();
          }}
        />
      )}
    </div>
  );
}

/** Writes a new SKILL.md in the account's skills folder. */
