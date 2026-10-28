import { useContext, useEffect, useRef, useState } from "react";
import { Suspense } from "react";
import { AppIcon } from "../../ui/app-icon";
import { lazyPiece } from "../../ui/lazy-piece";
import type { MenuPosition } from "../../ui/Menu";
import { permissionGlyphs12 } from "../permission-glyphs-12";
import type { Settings } from "../../../shared/types";
import { codeSandboxFor } from "../../../shared/sandbox-policy";
import { WithTooltip } from "../../ui/Tooltip";
import { usePolicy } from "../../policy/PolicyContext";
import { modeAllowed, modeRefusal } from "../../../shared/client-policy";
import { AppContext } from "../../app/AppContext";
import { preference } from "../../../shared/settings-extras";
import { useHost } from "../../host/HostContext";
import { formatText, t } from "../../i18n";
declare const __CLAUDEX_SURFACE__: "web" | "desktop" | undefined;
// Web CSS already omits this native glyph; keep its SVG data out of that build.
const nativePermissionGlyph =
  typeof __CLAUDEX_SURFACE__ === "undefined" || __CLAUDEX_SURFACE__ !== "web";

// The menu loads when first opened.
const PermissionModeMenu = lazyPiece(() => import("../PermissionModeMenu"));
const loadBypassDialog = () => import("../BypassDialog");
const BypassDialog = lazyPiece(loadBypassDialog, "BypassDialog");

export type PermissionChoice =
  "auto" | "manual" | "acceptEdits" | "plan" | "bypass";
const choices: {
  id: PermissionChoice;
  title: string;
  description: string;
  glyph: keyof typeof permissionGlyphs12;
}[] = [
  // The original's order: Manual, Accept edits, Plan, then Auto and Bypass
  // permissions where offered.
  {
    id: "manual",
    title: "Manual",
    description: "Always ask before making changes",
    glyph: "Hand",
  },
  {
    id: "acceptEdits",
    title: "Accept edits",
    description: "Automatically accept all file edits",
    glyph: "Code",
  },
  {
    id: "plan",
    title: "Plan",
    description: "Create a plan before making changes",
    glyph: "Scroll",
  },
  {
    id: "auto",
    title: "Auto",
    description: "Claudex handles permission decisions",
    glyph: "Lightning",
  },
  {
    id: "bypass",
    title: "Bypass permissions",
    description: "Accepts all permissions",
    glyph: "Warning",
  },
];

/**
 * Which rows the picker offers. Bypass is the user's own choice: it is
 * listed after they opt in in Settings → Claude Code, whatever the
 * administrator's policy (owner decision 3). The policy restricts the other
 * four. Windows offers the same modes as macOS.
 */
export function offeredPermissionChoices(
  policy: Parameters<typeof modeAllowed>[0],
  platform: NodeJS.Platform,
  allowBypassPermissions: boolean | undefined,
  /** The web: the modes the cloud sandbox supports; missing means all. */
  supported?: readonly PermissionChoice[],
) {
  return choices.filter((choice) =>
    supported && !supported.includes(choice.id)
      ? false
      : choice.id === "bypass"
        ? allowBypassPermissions === true
        : modeAllowed(policy, choice.id),
  );
}

/**
 * The observed web Code selector offers the runner's three decision modes:
 * Auto, then the remote "default" that the live bundle names Accept edits, then
 * Plan. A mode kept from elsewhere (Manual, Bypass) that the trigger shows
 * keeps its own checked row after them, so the trigger always has a row to
 * match.
 */
export function webCodePermissionChoices<T extends { id: PermissionChoice }>(
  offered: T[],
  selected?: PermissionChoice,
) {
  const ids: PermissionChoice[] = ["auto", "acceptEdits", "plan"];
  if (selected && !ids.includes(selected)) ids.push(selected);
  return ids.flatMap((id) => {
    const choice = offered.find((item) => item.id === id);
    return choice ? [choice] : [];
  });
}

type Patch = Pick<
  Settings,
  "codeSandbox" | "autoAcceptEdits" | "codePlanMode"
> &
  Pick<Settings, "bypassFolders">;

export function CodePermissionPicker({
  platform,
  sandbox,
  autoAcceptEdits,
  planMode,
  cwd,
  bypassFolders = [],
  onChange,
  onUnavailable,
  openRequest = 0,
  supportedModes,
  turnRunning = false,
  homeDraft = false,
  onNotice,
  sessionScoped = false,
  pendingStart = false,
}: {
  homeDraft?: boolean;
  sessionScoped?: boolean;
  pendingStart?: boolean;
  platform: NodeJS.Platform;
  sandbox: Settings["codeSandbox"];
  autoAcceptEdits: boolean;
  planMode: boolean;
  /** The folder the next turn runs in; Bypass is confirmed per folder. */
  cwd?: string;
  bypassFolders?: string[];
  onChange: (patch: Patch) => void;
  onUnavailable: (message: string) => void;
  openRequest?: number;
  /** The web's cloud sandbox supports these modes only (host.cloud). */
  supportedModes?: readonly PermissionChoice[];
  /**
   * A turn of the open session is running: a mode chosen now applies from
   * the next turn, so Bypass chosen now says it turns on afterwards.
   */
  turnRunning?: boolean;
  /** Shows a passing notice (the toast). */
  onNotice?: (message: string) => void;
}) {
  const policy = usePolicy();
  const app = useContext(AppContext);
  const web = useHost().kind === "web";
  useEffect(() => {
    if (!web) void loadBypassDialog().catch(() => {});
  }, [web]);
  // The preference, with its default (on): the raw value is undefined until the
  // setting is saved once, which read as "off" while Settings showed it on.
  const allowBypass = app
    ? preference(app.snapshot.settings, "allowBypassPermissions")
    : undefined;
  const cloud = supportedModes !== undefined;
  const offered = offeredPermissionChoices(
    policy,
    platform,
    allowBypass,
    supportedModes,
  );
  const [menuAt, setMenuAt] = useState<MenuPosition>();
  const open = Boolean(menuAt);
  const setOpen = (value: boolean | ((open: boolean) => boolean)) => {
    const next = typeof value === "function" ? value(open) : value;
    if (next && pendingStart) return;
    if (!next) return setMenuAt(undefined);
    const box = trigger.current?.getBoundingClientRect();
    if (box)
      setMenuAt({ left: box.left, bottom: window.innerHeight - box.top + 4 });
  };
  const [confirming, setConfirming] = useState<string>();
  const anchor = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (openRequest > 0) {
      setOpen(true);
      trigger.current?.focus();
    }
  }, [openRequest]);
  // The trigger's tooltip names Mod+Shift+M; nothing shows what the original
  // does with it, so it opens the menu.
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "m" ||
        !event.shiftKey ||
        event.altKey ||
        !(platform === "darwin" ? event.metaKey : event.ctrlKey)
      )
        return;
      event.preventDefault();
      setOpen(true);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [platform]);
  const effective = codeSandboxFor(
    {
      codeSandbox: sandbox,
      codePlanMode: planMode,
      bypassFolders,
      allowBypassPermissions: allowBypass,
    },
    cwd,
  );
  const selected: PermissionChoice = planMode
    ? "plan"
    : effective === "danger-full-access"
      ? "bypass"
      : autoAcceptEdits
        ? "acceptEdits"
        : sandbox === "read-only"
          ? "manual"
          : "auto";
  // Bypass chosen while a turn runs turns on with the next turn (a turn keeps
  // the mode it started in): the row says so until this turn ends, and a notice
  // says it once.
  const [bypassKept, setBypassKept] = useState(false);
  if (bypassKept && !turnRunning) setBypassKept(false);
  const bypassWaits = bypassKept && selected === "bypass";
  const keepBypass = () => {
    if (!turnRunning || selected === "bypass") return;
    setBypassKept(true);
    onNotice?.("Bypass permissions turns on when Claudex finishes working.");
  };
  const choose = (value: PermissionChoice) => {
    if (value !== "bypass" && !modeAllowed(policy, value)) {
      onUnavailable(modeRefusal(value));
      return;
    }
    if (
      value === "auto" ||
      value === "manual" ||
      value === "acceptEdits" ||
      value === "plan"
    ) {
      onChange({
        codeSandbox:
          value === "manual" || value === "plan"
            ? "read-only"
            : "workspace-write",
        autoAcceptEdits: value === "acceptEdits",
        codePlanMode: value === "plan",
      });
      setOpen(false);
      trigger.current?.focus();
    } else if (cloud) {
      // The web: every session runs in its own sandbox, so Bypass needs no
      // folder confirmation (the runner confirms them all).
      keepBypass();
      onChange({
        codeSandbox: "danger-full-access",
        autoAcceptEdits: false,
        codePlanMode: false,
      });
      setOpen(false);
      trigger.current?.focus();
    } else if (!cwd) {
      // The row says why (G-85); Bypass is confirmed per folder.
      return;
    } else if (bypassFolders.includes(cwd)) {
      bypass(cwd);
      trigger.current?.focus();
    } else {
      setOpen(false);
      setConfirming(cwd);
    }
  };
  // Codex full access: no sandbox and no approval requests.
  const bypass = (folder: string) => {
    keepBypass();
    onChange({
      codeSandbox: "danger-full-access",
      autoAcceptEdits: false,
      codePlanMode: false,
      bypassFolders: bypassFolders.includes(folder)
        ? bypassFolders
        : [...bypassFolders, folder],
    });
    setOpen(false);
  };
  const current = choices.find((choice) => choice.id === selected)!;
  const rows = (
    web ? webCodePermissionChoices(offered, selected) : offered
  ).map((choice) => {
    const needsFolder = choice.id === "bypass" && !cwd && !cloud;
    return {
      id: choice.id,
      title: choice.title,
      description: choice.description,
      glyph: choice.glyph,
      checked: selected === choice.id,
      disabledReason: needsFolder ? "Choose a folder first" : undefined,
      note:
        choice.id === "bypass" && bypassWaits
          ? "Turns on when Claudex finishes working."
          : undefined,
      onSelect: () => choose(choice.id),
    };
  });
  // Turned off in Settings → Claude Code: the row stays and leads there.
  if (!web && allowBypass !== true)
    rows.push({
      id: "bypass",
      title: "Bypass permissions",
      description:
        "Turn on Allow bypass permissions mode in Settings to use it.",
      glyph: "Warning",
      checked: false,
      disabledReason: undefined,
      note: undefined,
      onSelect: () => app?.openSettingsTab("code"),
    });
  return (
    <div ref={anchor} className="popover-anchor code-permission-anchor">
      {/* The original's trigger: a ghost button with the mode's glyph, its name
         and a 12px caret; its tooltip is the mode's description. */}
      <WithTooltip
        label={current.description}
        shortcut={["shift", "mod", "M"]}
        placement="above"
        gap={4}
        disabled={open}
      >
        {(tip) => (
          <button
            {...tip}
            ref={trigger}
            className={`permission-button code-permission-trigger mode-${selected} ${open ? "open" : ""}`}
            aria-label={
              web || homeDraft
                ? formatText("Permissions: {mode}", { mode: t(current.title) })
                : undefined
            }
            aria-haspopup="menu"
            disabled={pendingStart}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {nativePermissionGlyph && <PermissionGlyph name={current.glyph} />}
            <span>{current.title}</span>
            <span className="code-permission-caret">
              <AppIcon name="CaretDownSmall" />
            </span>
          </button>
        )}
      </WithTooltip>
      {menuAt && (
        <Suspense fallback={null}>
          <PermissionModeMenu
            sessionScoped={sessionScoped}
            rows={rows}
            inlineDescriptions={web}
            position={menuAt}
            anchor={trigger}
            onClose={() => {
              setMenuAt(undefined);
              trigger.current?.focus();
            }}
          />
        </Suspense>
      )}
      {confirming && (
        <Suspense fallback={null}>
          <BypassDialog
            folder={confirming}
            onCancel={() => {
              setConfirming(undefined);
              trigger.current?.focus();
            }}
            onConfirm={() => {
              bypass(confirming);
              setConfirming(undefined);
              trigger.current?.focus();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function PermissionGlyph({ name }: { name: keyof typeof permissionGlyphs12 }) {
  const Icon = permissionGlyphs12[name];
  return (
    <Icon
      className="code-permission-glyph"
      size={12}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}
