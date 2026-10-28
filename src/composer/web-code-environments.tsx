import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import type { MenuEntry } from "../ui/Menu";
import { PlusIcon } from "../ui/icons";
import { shortcutText } from "../ui/Tooltip";
import { t } from "../i18n";

export type WebCodeEnvironmentOptions = {
  /** Only profiles actually returned by the service. */
  environments: readonly CloudEnvironmentConfig[];
  selectedId?: string;
  loaded: boolean;
  error?: unknown;
  platform?: string;
  onChoose: (id: string) => void;
  onEdit: (environment: CloudEnvironmentConfig) => void;
  onCreate: () => void;
  onDownload: () => void;
};

/** The captured web root is shared by the centre and chin launchers. */
export function webCodeEnvironmentEntries(options: WebCodeEnvironmentOptions) {
  const profiles: MenuEntry[] = options.environments.map((environment) => ({
    label: environment.name,
    noTranslate: true,
    checked: environment.id === options.selectedId,
    checkedRole: "radio" as const,
    onSelect: () => options.onChoose(environment.id),
    settings: {
      label: "Edit cloud environment",
      onSelect: () => options.onEdit(environment),
    },
  }));
  const availability: MenuEntry[] = options.error
    ? [{ label: "Couldn’t load cloud environments", disabled: true }]
    : !options.loaded
      ? [{ label: "Loading…", disabled: true }]
      : !profiles.length
        ? [{ label: "No environments", disabled: true }]
        : [];
  return {
    entries: [
      {
        label: "Local",
        checked: false,
        checkedRole: "radio",
        badge: "Download",
        value: "Desktop only",
        valueLabel: `${t("Desktop only")}; ${t("Download the Claudex desktop app")}`,
        onSelect: options.onDownload,
      },
      { separator: true },
      {
        label: "Cloud",
        submenu: [...availability, ...profiles],
      },
      { separator: true },
      {
        label: "New environment",
        icon: <PlusIcon />,
        // Shared menus suppress shortcut nodes on web. This captured Code
        // action still shows its platform-specific combination.
        value:
          (options.platform ?? "darwin") === "darwin"
            ? shortcutText("darwin", ["alt", "mod", "0"]).replaceAll(" ", "")
            : shortcutText(options.platform!, ["alt", "mod", "0"]),
        onSelect: options.onCreate,
      },
    ] satisfies MenuEntry[],
    // Root labels do not contain a profile's name. Search the same real
    // leaf records as Cloud, retaining each profile's own select/edit ids.
    searchEntries: (query: string) => {
      const needle = query.trim().toLocaleLowerCase();
      return profiles.filter(
        (entry) =>
          "label" in entry && entry.label.toLocaleLowerCase().includes(needle),
      );
    },
  };
}

export function newCodeEnvironmentShortcut(
  event: KeyboardEvent,
  platform: string,
) {
  return (
    !event.isComposing &&
    !event.repeat &&
    event.altKey &&
    !event.shiftKey &&
    (platform === "darwin"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey) &&
    (event.code === "Digit0" || event.key === "0")
  );
}
