import type { MenuEntry } from "../../ui/Menu";
import type { DispatchStatus } from "../../../shared/dispatch-api";
import { createElement } from "react";
import { currentLocale, formatText } from "../../i18n";
import { AppIcon } from "../../ui/app-icon";
import { environmentMenu, type EnvironmentMenuOptions } from "../../ssh/model";
import {
  initialCloudEnvironment,
  type CloudEnvironmentConfig,
} from "../../../shared/cloud-environments-api";

/** Availability reasons for host capabilities, rather than saved cloud profiles. */
export const environmentReasons = {
  cloud: "Cloud environments aren't available in Claudex yet",
  ssh: "SSH needs OpenSSH on this computer and must be allowed by your administrator",
} as const;

/**
 * Local, Cloud and host groups: cloud rows select a profile; their gear edits
 * it separately.
 */
export function codeEnvironmentMenu(
  options: EnvironmentMenuOptions & {
    onEditLocal: () => void;
    environments?: CloudEnvironmentConfig[];
    selectedCloudId?: string;
    onCloud: (id: string) => void;
    onCreateCloud: () => void;
    onEditCloud: (environment: CloudEnvironmentConfig) => void;
    remote?: Partial<DispatchStatus> & { failed?: boolean };
    selectedRemoteId?: string;
    onRemote?: (id: string) => void;
    onSetupRemote?: () => void;
  },
): MenuEntry[] {
  const [local, ...ssh] = environmentMenu(options);
  const off = (label: string, reason: string): MenuEntry => ({
    label,
    title: reason,
    disabled: true,
    chevron: true,
  });
  const environments = options.environments ?? [initialCloudEnvironment];
  return [
    "label" in local
      ? {
          ...local,
          checked:
            !options.selectedRemoteId &&
            !options.selectedCloudId &&
            local.checked,
          settings: {
            label: "Edit local environment",
            onSelect: options.onEditLocal,
          },
        }
      : local,
    {
      label: "Cloud",
      searchable: environments.length > 10 ? "Search environments…" : undefined,
      searchEmpty: "No environments",
      submenu: [
        ...environments.map((environment) => ({
          label: environment.name,
          noTranslate: environment.id !== "default",
          checked: environment.id === options.selectedCloudId,
          onSelect: () => options.onCloud(environment.id),
          settings: {
            label: "Edit cloud environment",
            onSelect: () => options.onEditCloud(environment),
          },
        })),
        { label: "Add cloud environment…", onSelect: options.onCreateCloud },
      ],
    },
    {
      label: "Remote Control",
      chevron: true,
      searchable: "Search computers…",
      submenu: [
        ...(options.remote?.failed
          ? [{ label: "Couldn’t load your computers", disabled: true }]
          : []),
        ...(!options.remote ? [{ label: "Loading…", disabled: true }] : []),
        ...(options.remote?.devices ?? []).map((device): MenuEntry => ({
          label: device.name,
          noTranslate: true,
          checked: device.id === options.selectedRemoteId,
          description: options.remote?.onlineDeviceIds?.includes(device.id)
            ? undefined
            : formatText("offline"),
          title:
            device.sessions && device.sessions.active >= device.sessions.max
              ? formatText(
                  device.sessions.max === 1
                    ? "Remote Control is at capacity ({active} of {max} session). End one to start another."
                    : "Remote Control is at capacity ({active} of {max} sessions). End one to start another.",
                  device.sessions,
                )
              : undefined,
          onSelect: () => options.onRemote?.(device.id),
        })),
        { label: "Set up remote control", onSelect: options.onSetupRemote },
      ],
    },
    ...(ssh.length ? ssh : [off("SSH", environmentReasons.ssh)]),
  ];
}

/** A folder named like an id (a cloud session's or a task's workspace). */
const idNamed =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The start card's Choose environment: Local with This computer and the latest
 * folder, the rest under More with their count; then Cloud, Remote Control and
 * SSH as submenus. A folder named like an id is a cloud session's or a task's
 * own workspace, not a place to pick.
 */
export function expandedEnvironmentMenu(
  entries: MenuEntry[],
  recentLocal: MenuEntry[] = [],
): MenuEntry[] {
  const find = (label: string) =>
    entries.find(
      (entry): entry is Extract<MenuEntry, { label: string }> =>
        "label" in entry && entry.label === label,
    );
  const local = find("Local");
  const laptop = createElement(AppIcon, { name: "Laptop", size: 20 });
  const places = recentLocal
    .filter((entry) => !("label" in entry) || !idNamed.test(entry.label))
    .map((entry) => ("label" in entry ? { ...entry, icon: laptop } : entry));
  const [latest, ...rest] = places;
  const groups = ["Cloud", "Remote Control", "SSH"].flatMap(
    (label): MenuEntry[] => {
      const entry = find(label);
      return entry && (entry.submenu || !entry.disabled) ? [entry] : [];
    },
  );
  return [
    ...(local
      ? [
          { heading: "Local" },
          {
            ...local,
            label: "This computer",
            icon: laptop,
            submenu: undefined,
          },
          ...(latest ? [latest] : []),
          ...(rest.length
            ? [
                {
                  label: "More",
                  icon: laptop,
                  value: rest.length.toLocaleString(currentLocale()),
                  searchable: rest.length > 10 ? "Search folders…" : undefined,
                  submenu: rest,
                },
              ]
            : []),
          ...(groups.length ? [{ separator: true as const }] : []),
        ]
      : []),
    ...groups,
  ];
}
