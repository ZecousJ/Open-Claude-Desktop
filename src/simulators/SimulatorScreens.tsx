import { useRef, useState, type ReactNode } from "react";
import {
  Settings,
  Smartphone,
  UserCircle,
  Check,
  ChevronDown,
  Eye,
} from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import {
  simulatorNoun,
  type SimulatorDevice,
  type SimulatorKind,
  type SimulatorOpenTarget,
} from "../../shared/simulators";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { t } from "../i18n";
import { Modal } from "../ui/Controls";
import { deviceNameProblem } from "../../shared/simulators";
import {
  deviceText,
  pickerGroups,
  type Failure,
  type SetupSteps,
  type SetupTile,
} from "./simulator-model";

/** The original's screens of the pane share one shell: title, body, tiles, footer. */
export function Shell({ children }: { children: ReactNode }) {
  return <div className="sim-shell">{children}</div>;
}

/** "Checking your simulator setup…" while the first check runs. */
export function Checking({
  kind,
  problem,
}: {
  kind: SimulatorKind;
  /** Why the last check failed; the check keeps retrying underneath. */
  problem?: string;
}) {
  return (
    <Shell>
      <div className="sim-scroll">
        <h2 className="sim-title">
          {kind === "android"
            ? "Checking your Android setup…"
            : "Checking your simulator setup…"}
        </h2>
        <div className="sim-checking">
          <Spinner inheritColor className="spin" size={16} label="Loading" />
        </div>
        {problem && (
          <p className="sim-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </Shell>
  );
}

/** "Shutting down the simulator…" and its kin: a centred title over a spinner. */
export function Working({ text }: { text: string }) {
  return (
    <Shell>
      <div className="sim-scroll">
        <div className="sim-center" role="status">
          <h2 className="sim-title">{text}</h2>
          <Spinner inheritColor className="spin" size={16} label={text} />
        </div>
      </div>
    </Shell>
  );
}

/** A screen that says the kind can't run here, and why. */
export function Unavailable({ text }: { text: string }) {
  return (
    <Shell>
      <div className="sim-scroll">
        <div className="sim-center">
          <h2 className="sim-title">{text}</h2>
        </div>
      </div>
    </Shell>
  );
}

function Tile({
  tile,
  onCopy,
}: {
  tile: SetupTile;
  onCopy: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`sim-tile ${tile.state}`}>
      <span className="sim-tile-glyph">
        {tile.state === "done" ? (
          <span className="sim-tile-check" aria-hidden="true">
            <Check size={11} strokeWidth={3} />
          </span>
        ) : (
          <span className="sim-tile-circle" aria-hidden="true" />
        )}
      </span>
      <span className="sr-only">
        {tile.state === "done" ? "Done" : "Pending"}
      </span>
      <div>
        <p className="sim-tile-label">{tile.label}</p>
        {tile.sub && <p className="sim-tile-sub">{tile.sub}</p>}
        {tile.command && (
          <div className="sim-command">
            <code>{tile.command}</code>
            <button
              type="button"
              onClick={() => {
                onCopy(tile.command!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Set up the iOS simulator" / "Set up the Android emulator": the steps
 * as tiles that check themselves off while the pane polls the setup, and
 * the button that opens what the current step needs.
 */
export function SetupScreen({
  steps,
  onOpen,
  onCopy,
}: {
  steps: SetupSteps;
  onOpen: (target: SimulatorOpenTarget) => void;
  onCopy: (text: string) => void;
}) {
  return (
    <Shell>
      <div className="sim-scroll">
        <h2 className="sim-title">{steps.title}</h2>
        <p className="sim-body">
          Progress updates automatically as each step finishes.
        </p>
        <div className="sim-tiles">
          {steps.tiles.map((tile) => (
            <Tile key={tile.key} tile={tile} onCopy={onCopy} />
          ))}
        </div>
        <div className="sim-polling">
          <Spinner inheritColor className="spin" size={14} aria-hidden="true" />
          <span>{steps.polling}</span>
        </div>
      </div>
      <div className="sim-footer">
        <p className="sim-footnote">{steps.footnote}</p>
        {steps.action && (
          <button
            type="button"
            className="sim-primary"
            onClick={() => onOpen(steps.action!.target)}
          >
            {steps.action.label}
          </button>
        )}
      </div>
    </Shell>
  );
}

/** The device list as a menu: Booted, then Available (will boot). */
/** A device row's right-click actions. */
export type DeviceAction = "shutdown" | "restart" | "start" | "rename";

/** What a device in the middle of an action says instead of being chosen. */
export const deviceActionBusyLabels: Record<DeviceAction, string> = {
  shutdown: "Shutting down",
  start: "Starting",
  restart: "Restarting",
  rename: "Renaming",
};

/** Booted: Shut down and Restart; otherwise Start; iOS adds Rename…. */
export function deviceActions(
  kind: SimulatorKind,
  booted: boolean,
): DeviceAction[] {
  const actions: DeviceAction[] = booted ? ["shutdown", "restart"] : ["start"];
  if (kind === "ios") actions.push("rename");
  return actions;
}

const deviceActionLabels: Record<DeviceAction, string> = {
  shutdown: "Shut down",
  restart: "Restart",
  start: "Start",
  rename: "Rename…",
};

export interface DeviceRowActions {
  /** The devices in the middle of an action, and which. */
  busy: Readonly<Record<string, DeviceAction>>;
  onAction: (device: SimulatorDevice, action: DeviceAction) => void;
}

export function deviceEntries(
  kind: SimulatorKind,
  devices: readonly SimulatorDevice[],
  current: string | undefined,
  onPick: (device: SimulatorDevice) => void,
  rowActions?: DeviceRowActions,
): MenuEntry[] {
  const { booted, available } = pickerGroups(devices);
  if (!booted.length && !available.length)
    return [
      {
        heading:
          kind === "android" ? "No emulators found" : "No simulators found",
      },
      {
        label:
          kind === "android"
            ? "Create one in Android Studio."
            : "Install one in Xcode.",
        disabled: true,
      },
    ];
  const row = (device: SimulatorDevice): MenuEntry => {
    const busy = rowActions?.busy[device.id];
    return {
      label: deviceText(device),
      noTranslate: true,
      checked: device.id === current,
      disabled: busy !== undefined,
      title: busy ? t(deviceActionBusyLabels[busy]) : undefined,
      onSelect: () => onPick(device),
      contextMenu:
        rowActions && !busy
          ? deviceActions(kind, device.state === "booted").map((action) => ({
              label: deviceActionLabels[action],
              onSelect: () => rowActions.onAction(device, action),
            }))
          : undefined,
    };
  };
  return [
    ...(booted.length ? [{ heading: "Booted" }, ...booted.map(row)] : []),
    ...(booted.length && available.length
      ? [{ separator: true as const }]
      : []),
    ...(available.length
      ? [{ heading: "Available (will boot)" }, ...available.map(row)]
      : []),
  ];
}

/** Where a menu opens under its button, in window coordinates. */
export function below(button: HTMLElement | null): MenuPosition {
  const box = button?.getBoundingClientRect();
  return box ? { left: box.left, top: box.bottom + 5 } : { left: 16, top: 48 };
}

/**
 * "Attach a simulator so Claudex can see your app": a split button, the
 * first booted device (or the first that would boot) and a caret that
 * picks another.
 */
export function AttachScreen({
  kind,
  devices,
  busy,
  failure,
  notice,
  onAttach,
  rowActions,
}: {
  kind: SimulatorKind;
  devices: readonly SimulatorDevice[] | null;
  /** Booting a shut-down device, or attaching a booted one. */
  busy?: "boot" | "attach";
  failure?: Failure;
  /** A line in place of "Shut-down devices boot automatically." ("This simulator was shut down…"). */
  notice?: string;
  onAttach: (device: SimulatorDevice) => void;
  rowActions?: DeviceRowActions;
}) {
  const caret = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const noun = simulatorNoun[kind];
  const first = devices
    ? (pickerGroups(devices).booted[0] ?? pickerGroups(devices).available[0])
    : undefined;
  return (
    <Shell>
      <div className="sim-scroll">
        <h2 className="sim-title">
          {kind === "android"
            ? "Attach an emulator so Claudex can see your app"
            : "Attach a simulator so Claudex can see your app"}
        </h2>
        <p className="sim-body">
          {kind === "android"
            ? "Claudex will control this emulator and take screenshots of its entire screen."
            : "Claudex will control this simulator and take screenshots of its entire screen."}
        </p>
        {/* An error or notice takes the hint's place. */}
        {!failure && !notice && (
          <p className="sim-body">Shut-down devices boot automatically.</p>
        )}
        {notice && (
          <p className="sim-body" role="status">
            {notice}
          </p>
        )}
        {failure && (
          <p className="sim-error" role="alert">
            {failure.title}
            <br />
            <span data-no-translate>{failure.detail}</span>
          </p>
        )}
        <div className="sim-tiles">
          <Tile
            tile={{
              key: "ready",
              state: "done",
              label:
                kind === "android"
                  ? "Android SDK and emulator installed"
                  : "Xcode and Simulator installed",
            }}
            onCopy={() => {}}
          />
        </div>
      </div>
      <div className="sim-footer">
        <p className="sim-footnote">
          {kind === "android"
            ? "Android is a trademark of Google LLC."
            : "Xcode is a trademark of Apple Inc., registered in the U.S. and other countries."}
        </p>
        <div className="sim-split">
          <button
            type="button"
            className="sim-primary"
            disabled={busy !== undefined || !first}
            onClick={() => first && onAttach(first)}
          >
            {busy === "boot"
              ? "Booting…"
              : busy
                ? "Attaching…"
                : `Attach ${noun}`}
          </button>
          <button
            ref={caret}
            type="button"
            className="sim-split-caret"
            aria-label={t(
              noun === "emulator" ? "Choose emulator" : "Choose simulator",
            )}
            aria-haspopup="menu"
            aria-expanded={menu !== undefined}
            disabled={busy !== undefined || !devices}
            onClick={() => setMenu(menu ? undefined : below(caret.current))}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      {menu && devices && (
        <Menu
          label={t(
            noun === "emulator" ? "Choose emulator" : "Choose simulator",
          )}
          entries={deviceEntries(
            kind,
            devices,
            undefined,
            (device) => onAttach(device),
            rowActions,
          )}
          position={menu}
          width={260}
          anchors={[caret]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </Shell>
  );
}

/** "Let Claudex use this simulator?": what Claudex will see and do, before the first use. */
export function PermissionScreen({
  kind,
  device,
  busy,
  onCancel,
  onContinue,
}: {
  kind: SimulatorKind;
  device: SimulatorDevice;
  busy: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <Shell>
      <div className="sim-scroll">
        <h2 className="sim-title">
          {kind === "android"
            ? "Let Claudex use this emulator?"
            : "Let Claudex use this simulator?"}
        </h2>
        <span className="sim-chip">
          <Smartphone size={14} aria-hidden="true" />
          {deviceText(device)}
        </span>
        <p className="sim-permission-body">
          Claudex will view this device’s screen through screenshots and control
          it by tapping and typing.
        </p>
        <p className="sim-permission-body">
          Screenshots are sent to the model and follow your conversation
          retention settings.
        </p>
        <div className="sim-bullets">
          <div className="sim-bullet">
            <Eye size={15} aria-hidden="true" />
            <p>
              Anything on the screen, including notifications and other open
              apps, can end up in your conversation.
            </p>
          </div>
          <div className="sim-bullet">
            <UserCircle size={15} aria-hidden="true" />
            <p>
              Don’t sign in to real accounts. Use test accounts and test data
              instead.
            </p>
          </div>
          <div className="sim-bullet">
            <Settings size={15} aria-hidden="true" />
            <p>
              {kind === "android"
                ? "You can turn off emulator access at any time in Settings."
                : "You can turn off simulator access at any time in Settings."}
            </p>
          </div>
        </div>
      </div>
      <div className="sim-permission-footer">
        <button
          type="button"
          className="sim-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sim-primary"
          disabled={busy}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </Shell>
  );
}

/**
 * Rename simulator: a small dialog with the name selected in its field, the
 * reason under it when the name can't be used (too long, a leading hyphen, a
 * hidden character), Cancel and Rename (off while the name can't be used). An
 * unchanged name just closes.
 */
export function RenameDeviceDialog({
  initialName,
  onRename,
  onClose,
}: {
  initialName: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const name = value.trim();
  const problem = deviceNameProblem(name);
  // An empty field only turns Rename off; it says nothing.
  const shown = name === "" ? undefined : problem;
  const submit = () => {
    if (problem) return;
    if (name !== initialName) onRename(name);
    onClose();
  };
  return (
    <Modal title={t("Rename simulator")} onClose={onClose} variant="confirm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          className="sim-rename-field"
          aria-label={t("Rename simulator")}
          aria-invalid={shown ? true : undefined}
          value={value}
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => setValue(event.target.value)}
        />
        {shown && (
          <p className="sim-rename-error" role="alert">
            {t(shown)}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={problem !== undefined}
          >
            {t("Rename")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
