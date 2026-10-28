import { useContext, type ReactNode } from "react";
import type { Conversation, Mode } from "../../shared/types";
import { browserPolicyOf } from "../../shared/client-policy";
import type { SidePanel } from "../conversation/ToolSidePanel";
import { AppContext } from "../app/AppContext";
import { useHost, useHostCapability } from "../host/HostContext";
import { browserToggleShown } from "../browser/browser-model";
import {
  simulatorPanelId,
  simulatorToggleShown,
} from "../simulators/simulator-model";
import { simulatorKinds, simulatorKindLabel } from "../../shared/simulators";
import { AppIcon } from "../ui/app-icon";
import { isMacPlatform } from "../host/keys";
import { filesPaneAvailable } from "../files/files-model";

/** A pane the Code header toggles (a button, or a View options row once folded). */
export interface PaneSpec {
  id: string;
  icon: ReactNode;
  label: string;
  /** The keys, as the tooltips and menus write them (["mod", "shift", "D"]). */
  shortcut?: string[];
  active: boolean;
  disabled?: boolean;
  /** Why it is greyed. */
  reason?: string;
  /** A count after the label in View options (Background tasks). */
  count?: number;
  toggle: () => void;
}

/**
 * The Code header's panes: Terminal (⌘J on macOS, Ctrl+` elsewhere), Changes
 * (⇧⌘D), Preview or Browser (⇧⌘B), the iOS and Android simulators and Files
 * (⇧⌘F), as ghost icon buttons (View options' own rows are its module's,
 * src/code-view-options/CodeViewOptions.tsx).
 */
export function useCodePanes(
  conversation: Conversation,
  mode: Mode,
  /** The bar alone, without the window's state (tests): its own panel and toggle. */
  alone?: {
    panel: SidePanel | null;
    onTogglePanel: (value: SidePanel) => void;
  },
): PaneSpec[] {
  const app = useContext(AppContext);
  const capability = useHostCapability("browserPanel");
  const host = useHost();
  if ((mode !== "code" && mode !== "cowork") || (!app && !alone)) return [];
  const mac = isMacPlatform(app?.snapshot.platform);
  const terminal = host.capabilities.localTerminal;
  const cloud = host.kind === "web";
  const isOpen = (value: SidePanel) =>
    app ? app.toolPanels.isOpen(value) : alone?.panel === value;
  const toggle = (value: SidePanel) => () => {
    if (!app) return alone?.onTogglePanel(value);
    app.toolPanels.toggle(value);
  };
  const settings = (app?.snapshot.settings ?? {}) as unknown as Record<
    string,
    unknown
  >;
  const browser =
    !!app &&
    browserToggleShown({
      mode,
      cloudHosted: conversation.cloudHosted,
      capability,
      policyEnabled: browserPolicyOf(app.policy).enabled,
      settings,
    });
  // The web's cloud sessions have neither a terminal nor a browser pane.
  const panes: PaneSpec[] = [
    {
      id: "terminal",
      icon: <AppIcon name="CommandLinePrompt" />,
      label: "Terminal",
      shortcut: mac ? ["mod", "J"] : ["ctrl", "`"],
      active: isOpen("terminal"),
      disabled: !terminal,
      toggle: toggle("terminal"),
    },
    {
      id: "changes",
      icon: <AppIcon name="ChangesPlusMinus" />,
      label: "Changes",
      shortcut: ["mod", "shift", "D"],
      active: isOpen("changes"),
      toggle: toggle("changes"),
    },
  ];
  if (browser)
    panes.push({
      id: "browser",
      icon: <AppIcon name="Globe" />,
      // The original names the pane Preview while Browser tools are off.
      label: settings.browserTools === false ? "Preview" : "Browser",
      shortcut: ["mod", "shift", "B"],
      active: isOpen("browser"),
      toggle: toggle("browser"),
    });
  if (filesPaneAvailable(conversation))
    panes.push({
      id: "files",
      icon: <AppIcon name="Folder" />,
      label: "Files",
      shortcut: ["mod", "shift", "F"],
      active: isOpen("files"),
      toggle: toggle("files"),
    });
  for (const kind of simulatorKinds)
    if (
      app &&
      simulatorToggleShown({
        kind,
        mode,
        desktop: host.kind === "desktop",
        platform: app.snapshot.platform,
        settings,
      })
    )
      panes.push({
        id: simulatorPanelId[kind],
        icon: <AppIcon name="MobilePhone" />,
        label: simulatorKindLabel[kind],
        active: isOpen(simulatorPanelId[kind]),
        toggle: toggle(simulatorPanelId[kind]),
      });

  return mode === "cowork"
    ? panes.filter((pane) => pane.id === "browser" && browser)
    : cloud
      ? panes.filter((pane) => pane.id !== "terminal")
      : panes;
}

/**
 * Which panes fold into View options when `hidden` must go (the original's
 * fold): closed panes first, in order, then open ones.
 */
export function foldPanes<T extends { active: boolean }>(
  panes: readonly T[],
  hidden: number,
): { inline: T[]; folded: T[] } {
  const count = Math.min(Math.max(0, Math.trunc(hidden) || 0), panes.length);
  if (!count) return { inline: [...panes], folded: [] };
  const order = [
    ...panes.filter((pane) => !pane.active),
    ...panes.filter((pane) => pane.active),
  ];
  const gone = new Set(order.slice(0, count));
  return {
    inline: panes.filter((pane) => !gone.has(pane)),
    folded: panes.filter((pane) => gone.has(pane)),
  };
}

/**
 * How many header buttons fold (the original's title bar measure): the
 * title gives up its width down to 100px first, then buttons go one slot
 * (a button and its gap) at a time; the rail toggle folds first and at
 * most seven go (six without the rail toggle).
 */
export function foldCount({
  available,
  needed,
  slot,
  max,
}: {
  /** The bar's width. */
  available: number;
  /** What everything needs with every button shown and the title at its least. */
  needed: number;
  slot: number;
  max: number;
}) {
  const short = needed - available;
  if (short <= 1) return 0;
  return Math.min(max, Math.ceil(short / slot));
}
