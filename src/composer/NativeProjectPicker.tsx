import { useContext, useEffect, useRef, type RefObject } from "react";
import { AppContext } from "../app/AppContext";
import { useT } from "../i18n";
import { requestFolderAccess } from "../cowork/useFolderAccess";
import { PlacePickerSurface } from "./PlacePickerSurface";
import type { ProjectPickerProps } from "./ProjectPicker";
import { typedProjectName } from "./project-picker-model";
import {
  defaultProjectId,
  setDefaultProjectId,
  setProjectPickerSort,
  useProjectPickerPreferences,
} from "./project-picker-preferences";
import {
  setNativeDefaultFolder,
  setNativeShowFolders,
  useNativePlacePreferences,
} from "./native-place-preferences";
import {
  knownLocalFolder,
  liveNativeProjectFolder,
  nativePlaceRows,
} from "./native-place-model";
import {
  invalidateNativeDefaultPlace,
  nativePlaceGeneration,
} from "./native-default-place";
import { markExplicitFolderSelection } from "./explicit-folder-selection";
import { folderName } from "./recentFolders";
import { useProjectCatalogState } from "./useProjectCatalogState";

/**
 * Native data adapter for the same combobox used by web ProjectPicker.
 * Filter/sort, Pinned/default, typed creation and folder rows.
 */
export type NativeProjectPickerProps = ProjectPickerProps & {
  cwd?: string;
  setCwd(folder?: string): void;
  pickFolder(): Promise<void>;
  externalTrigger?: {
    anchor: RefObject<HTMLButtonElement | null>;
    popup?: RefObject<HTMLDivElement | null>;
    onClose(): void;
  };
};
export function NativeProjectPicker(props: NativeProjectPickerProps) {
  const app = useContext(AppContext);
  const t = useT();
  const projectRead = useProjectCatalogState();
  const accountId = app?.accountId ?? "local";
  const { defaultId, sort } = useProjectPickerPreferences(accountId);
  const { folder: defaultFolder, showFolders } =
    useNativePlacePreferences(accountId);
  const conversations = app?.snapshot.conversations ?? [];
  const latest = useRef({ app, props });
  latest.current = { app, props };
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!props.externalTrigger) generation.current++;
    };
  }, []);
  const begin = () => ({
    local: ++generation.current,
    global: app ? invalidateNativeDefaultPlace(app) : 0,
  });
  const allowed = async (
    path: string | undefined,
    projectId: string | undefined,
    apply: () => void,
  ) => {
    const ticket = begin();
    const started = latest.current;
    const valid = () => {
      const now = latest.current;
      const live = now.app?.currentController
        ? now.app.currentController.current
        : now.app;
      const attached = started.props.externalTrigger
        ? started.props.externalTrigger.anchor.current?.isConnected
        : mounted.current;
      return (
        attached &&
        ticket.local === generation.current &&
        (!now.app || ticket.global === nativePlaceGeneration(now.app)) &&
        now.app?.accountId === started.app?.accountId &&
        now.app?.controllerScope === started.app?.controllerScope &&
        now.props.cwd === started.props.cwd &&
        now.props.project?.id === started.props.project?.id &&
        (!started.app ||
          Boolean(
            live &&
            live.accountId === started.app.accountId &&
            live.controllerScope === started.app.controllerScope &&
            live.draftSession === started.app.draftSession &&
            !live.activeId &&
            !live.incognitoShown &&
            !live.sending &&
            (!now.app?.currentController ||
              (live.cwd === started.props.cwd &&
                live.projectId === started.props.project?.id)),
          ))
      );
    };
    try {
      if (
        path &&
        (await requestFolderAccess(path, {
          notify: app?.notify,
          ...(projectId ? { projectId } : {}),
        })) !== "granted"
      )
        return;
      if (valid()) apply();
    } catch (error) {
      if (valid()) app?.report(error);
    }
  };
  const pickProject = (project: ProjectPickerProps["projects"][number]) => {
    if (project.id === props.project?.id) {
      begin();
      props.onProject("");
      if (project.cwd && props.cwd === project.cwd) props.setCwd(undefined);
      return;
    }
    void allowed(project.cwd, project.id, () => {
      if (project.cwd && app) markExplicitFolderSelection(app);
      props.onProject(project.id);
    });
  };
  const pickFolder = (path: string) => {
    if (props.cwd === path) {
      begin();
      props.setCwd(undefined);
      return;
    }
    void allowed(path, undefined, () => {
      if (app) markExplicitFolderSelection(app);
      props.setCwd(path);
    });
  };
  const extra = Boolean(
    props.project && props.cwd && props.cwd !== props.project.cwd,
  );
  const label = props.project
    ? `${props.project.name}${extra ? " +1" : ""}`
    : props.cwd
      ? folderName(props.cwd)
      : t("Project or folder");
  return (
    <PlacePickerSurface
      projectRead={projectRead}
      native
      label={label}
      chosen={Boolean(props.project || props.cwd)}
      collapsed={props.collapsed}
      platform={props.platform}
      badgeCount={extra ? 2 : 1}
      externalTrigger={props.externalTrigger}
      content={(query) => {
        const name =
          projectRead.status === "pending"
            ? undefined
            : typedProjectName(props.projects, query);
        const rows = nativePlaceRows({
          projects: props.projects,
          conversations,
          project: props.project,
          cwd: props.cwd,
          query,
          sort,
          defaultId,
          defaultFolder,
          showFolders,
        });
        return {
          rows: rows.map((row) => ({
            key: row.key,
            name: row.name,
            detail: row.path,
            icon:
              row.kind === "folder"
                ? ("Folder" as const)
                : ("Projects" as const),
            selected: row.selected,
            isDefault: row.isDefault,
            section: row.section,
            defaultUnavailableReason:
              row.kind === "folder" &&
              !row.isDefault &&
              !knownLocalFolder(row.path, conversations)
                ? t(
                    "Use this folder in a conversation before setting it as default.",
                  )
                : undefined,
            onPick: () =>
              row.project ? pickProject(row.project) : pickFolder(row.path!),
            onDefault:
              (!row.pinned || row.isDefault) &&
              (row.isDefault ||
                !row.path ||
                liveNativeProjectFolder(row.project) ||
                knownLocalFolder(row.path, conversations))
                ? () => {
                    if (app) invalidateNativeDefaultPlace(app);
                    if (row.isDefault) {
                      setDefaultProjectId(accountId, undefined);
                      setNativeDefaultFolder(
                        accountId,
                        undefined,
                        conversations,
                      );
                    } else if (row.project)
                      setDefaultProjectId(accountId, row.project.id);
                    else
                      setNativeDefaultFolder(
                        accountId,
                        row.path,
                        conversations,
                      );
                  }
                : undefined,
          })),
          footer: [
            {
              key: "create",
              name: name ? `${t("Create")} ${name}` : t("New project"),
              createName: name,
              icon: "Plus" as const,
              onPick: () => {
                begin();
                props.onCreateProject(name);
              },
            },
            {
              key: "browse",
              name: t("Add folder"),
              icon: "FolderPlus" as const,
              onPick: () => {
                begin();
                void props.pickFolder().catch((error) => app?.report(error));
              },
            },
          ],
        };
      }}
      controls={[
        {
          key: "recent",
          label: "Recent activity",
          checked: sort === "recent",
          onPick: () => setProjectPickerSort(accountId, "recent"),
        },
        { key: "updated", label: "Last edited", disabled: true, onPick() {} },
        {
          key: "created",
          label: "Date created",
          checked: sort === "created",
          onPick: () => setProjectPickerSort(accountId, "created"),
        },
        {
          key: "name",
          label: "Name",
          checked: sort === "name",
          onPick: () => setProjectPickerSort(accountId, "name"),
        },
        {
          key: "folders",
          label: "Folders",
          section: "Show",
          icon: "Folder",
          checked: showFolders,
          checkbox: true,
          onPick: () => setNativeShowFolders(accountId, !showFolders),
        },
      ]}
    />
  );
}
