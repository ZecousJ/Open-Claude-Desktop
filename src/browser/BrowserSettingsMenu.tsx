import {
  browserColorSchemes,
  browserKeepCookiesChoices,
  browserViewports,
  keepCookiesOf,
  viewportFrame,
  type BrowserColorScheme,
  type BrowserKeepCookies,
  type BrowserViewport,
  type BrowserViewportPreset,
} from "../../shared/browser";
import type { MenuEntry } from "../ui/Menu";
import type { Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { hasPreference, keepCookiesLabels } from "./browser-model";

export const viewportLabels: Record<BrowserViewportPreset, string> = {
  desktop: "Responsive",
  mobile: "Mobile",
  tablet: "Tablet",
};
export const colorSchemeLabels: Record<BrowserColorScheme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** A device viewport's size as the original writes it, "375 × 812". */
export function viewportSize(viewport: BrowserViewport) {
  const frame = viewportFrame(viewport);
  return frame ? `${frame.width} × ${frame.height}` : undefined;
}

export interface BrowserSettingsActions {
  openElsewhere: () => void;
  copyUrl: () => void;
  setViewport: (viewport: BrowserViewport) => void;
  setColorScheme: (scheme: BrowserColorScheme) => void;
  /** Enable or Disable auto verify: asks first (the project's launch.json). */
  toggleAutoVerify?: () => void;
  saveScreenshot: () => void;
  openHtmlFile: () => void;
  setPreference: (key: string, value: unknown) => void;
  manageAllowedSites: () => void;
  /** Keep cookies: its choices open in the menu's place. */
  chooseKeepCookies: () => void;
  clearBrowsingData: () => void;
  importCookies?: () => void;
  useImportedCookies?: () => void;
  showAnnotationTools?: () => void;
  exportFile?: () => void;
  hasExportFile?: boolean;
  cowork?: boolean;
}

/**
 * The browser settings menu under ⋮: Open in <default browser> and Save
 * screenshot (greyed without a page), Open HTML file…; Open links in built-in
 * browser, Auto-verify changes, Manage allowed sites…; the Cookies group with
 * Keep cookies and Clear browsing data in red, and Import cookies…. A switch
 * whose preference this build does not have is left out, and the
 * Browser-tools-only rows need Browser tools.
 */
export function browserSettingsEntries({
  browserName,
  hasPage,
  canOpenElsewhere,
  toolsAvailable,
  viewport = "desktop",
  colorScheme = "system",
  autoVerify,
  settings,
  actions,
}: {
  browserName: string | null;
  hasPage: boolean;
  canOpenElsewhere: boolean;
  toolsAvailable: boolean;
  viewport?: BrowserViewport;
  colorScheme?: BrowserColorScheme;
  /** The project's auto verify (absent: no project to save it in). */
  autoVerify?: boolean;
  settings: Record<string, unknown> | undefined;
  actions: BrowserSettingsActions;
}): MenuEntry[] {
  const entries: MenuEntry[] = [
    {
      label: browserName ? `Open in ${browserName}` : "Open in browser",
      disabled: !canOpenElsewhere,
      title: canOpenElsewhere ? undefined : "This only works for websites.",
      onSelect: actions.openElsewhere,
    },
    {
      label: "Copy URL",
      disabled: !canOpenElsewhere,
      title: canOpenElsewhere ? undefined : "This only works for websites.",
      onSelect: actions.copyUrl,
    },
    {
      label: "Save screenshot",
      disabled: !hasPage,
      onSelect: actions.saveScreenshot,
    },
    ...(actions.showAnnotationTools
      ? [
          {
            label: "Show annotation tools",
            disabled: !hasPage,
            onSelect: actions.showAnnotationTools,
          },
        ]
      : []),
    { label: "Open HTML file…", onSelect: actions.openHtmlFile },
    {
      label: "Export",
      disabled: !hasPage,
      submenu: [
        ...(actions.hasExportFile && actions.exportFile
          ? [{ label: "Export…", onSelect: actions.exportFile }]
          : []),
        {
          label: "Save screenshot",
          disabled: !hasPage,
          onSelect: actions.saveScreenshot,
        },
      ],
    },
    { separator: true },
    {
      label: "Viewport",
      value:
        viewportSize(viewport) ??
        (typeof viewport === "string" ? viewportLabels[viewport] : "Custom"),
      disabled: !hasPage,
      title: hasPage ? undefined : "Open a page first.",
      submenu: [
        ...browserViewports.map((choice) => ({
          label: viewportLabels[choice],
          value: viewportSize(choice),
          checked: choice === viewport,
          onSelect: () => actions.setViewport(choice),
        })),
        ...(typeof viewport === "object"
          ? [
              {
                label: "Custom",
                value: viewportSize(viewport),
                checked: true,
                onSelect: () => actions.setViewport(viewport),
              },
            ]
          : []),
      ],
    },
    {
      label: "Color scheme",
      value: colorSchemeLabels[colorScheme],
      submenu: (["light", "dark", "system"] as const)
        .filter((choice) => browserColorSchemes.includes(choice))
        .map((choice) => ({
          label: colorSchemeLabels[choice],
          checked: choice === colorScheme,
          onSelect: () => actions.setColorScheme(choice),
        })),
    },
  ];
  const switches: MenuEntry[] = [];
  const saved = (settings ?? {}) as unknown as Settings;
  if (hasPreference("browserOpenLinksInApp")) {
    const on = preference(saved, "browserOpenLinksInApp");
    switches.push({
      label: "Open links in built-in browser",
      checked: on,
      onSelect: () => actions.setPreference("browserOpenLinksInApp", !on),
    });
  }
  // The original's per-project Enable or Disable auto verify (saved in the
  // project's launch.json); without a project, the setting's switch.
  if (toolsAvailable && actions.toggleAutoVerify && autoVerify !== undefined)
    switches.push({
      label: autoVerify ? "Disable auto verify" : "Enable auto verify",
      onSelect: actions.toggleAutoVerify,
    });
  else if (toolsAvailable && hasPreference("browserAutoVerify")) {
    const on = preference(saved, "browserAutoVerify");
    switches.push({
      label: "Auto-verify changes",
      checked: on,
      onSelect: () => actions.setPreference("browserAutoVerify", !on),
    });
  }
  if (toolsAvailable && hasPreference("browserAllowedSites"))
    switches.push({
      label: "Manage allowed sites…",
      onSelect: actions.manageAllowedSites,
    });
  if (switches.length) entries.push({ separator: true }, ...switches);
  entries.push({ separator: true }, { heading: "Cookies" });
  if (actions.importCookies)
    entries.push({ label: "Import cookies…", onSelect: actions.importCookies });
  if (actions.useImportedCookies)
    entries.push({
      label: "Use cookies you already imported",
      onSelect: actions.useImportedCookies,
    });
  if (!actions.cowork && hasPreference("browserKeepCookies"))
    entries.push({
      label: "Keep cookies",
      value: keepCookiesLabels[keepCookiesOf(settings?.browserKeepCookies)],
      onSelect: actions.chooseKeepCookies,
    });
  entries.push({
    label: "Clear browsing data",
    danger: true,
    onSelect: actions.clearBrowsingData,
  });
  return entries;
}

/**
 * What each Keep cookies choice means (the original's descriptions; only
 * Cowork and Code sessions use the same persistent browser partition).
 */
export const keepCookiesDescriptions: Record<BrowserKeepCookies, string> = {
  "until-quit": "Cookies are cleared when the app quits",
  always: "Cowork and all Code sessions share cookies",
  "per-session": "Each session keeps its own cookies",
};

/**
 * Keep cookies' choices (the Settings page's Keep cookies), shown in the
 * menu's place: a submenu to the right of a panel at the window's edge
 * would leave the window.
 */
export function keepCookiesEntries(
  settings: Record<string, unknown> | undefined,
  choose: (value: BrowserKeepCookies) => void,
): MenuEntry[] {
  const keep = keepCookiesOf(settings?.browserKeepCookies);
  return [
    { heading: "Keep cookies" },
    ...browserKeepCookiesChoices.map((choice) => ({
      label: keepCookiesLabels[choice],
      description: keepCookiesDescriptions[choice],
      descriptionWraps: true,
      checked: choice === keep,
      onSelect: () => choose(choice),
    })),
  ];
}
