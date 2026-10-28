import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Lock, ChevronDown, Monitor, Search, X } from "../ui/glyphs";
import type {
  ComputerUseAppRef,
  ComputerUsePermissionKind,
  ComputerUsePermissionState,
  ComputerUseSettings,
  ComputerUseState,
} from "../../shared/computer-use-api";
import { Button, Row, Toggle } from "../settings/controls";
import { usePolicy } from "../policy/PolicyContext";
import { useDismiss } from "../ui/useDismiss";
import { SegmentedControl } from "../ui/SegmentedControl";
import { saveComputerUseSettings, useComputerUse } from "./useComputerUse";
import { PermissionRow } from "./PermissionRow";
import { lazyPiece } from "../ui/lazy-piece";

const EnableComputerUseDialog = lazyPiece(
  () => import("./EnableComputerUseDialog"),
  "EnableComputerUseDialog",
);

type InstalledApp = ComputerUseAppRef & { icon?: string };

/** The id a denied-apps entry is compared by (case and ".exe" ignored). */
const appKey = (id: string) => id.toLowerCase().replace(/\.exe$/, "");

/**
 * Settings → System → Computer use (Beta), R-1399-02/03. Shown only while
 * the administrator's policy, this computer and the bundled driver allow
 * computer use; otherwise nothing of it appears. The original's "Not
 * available in cloud Code sessions" note is left out: Claudex has no cloud
 * sessions.
 */
export function ComputerUseSection({
  platform,
  onError,
}: {
  platform: string;
  onError: (error: unknown) => void;
}) {
  const state = useComputerUse();
  if (!state?.available) return null;
  if (platform !== "darwin" && platform !== "win32") return null;
  return (
    <ComputerUseRows state={state} platform={platform} onError={onError} />
  );
}

function ComputerUseRows({
  state,
  platform,
  onError,
}: {
  state: ComputerUseState;
  platform: string;
  onError: (error: unknown) => void;
}) {
  const policy = usePolicy();
  const learnMore = policy.links.learnMore.find((link) =>
    /computer use/i.test(link.label),
  )?.url;
  const { settings } = state;
  const enabled = settings.enabled;
  const save = (patch: Partial<ComputerUseSettings>) =>
    void saveComputerUseSettings(patch).catch(onError);
  const permissions = platform === "darwin" ? state.permissions : undefined;
  const fullControlAllowed = state.allowFullControl;
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="settings-section cu-section">
      <h2>
        Computer use <span className="cu-badge">Beta</span>
      </h2>
      <div className="settings-section-note tight">
        Not available in cloud Code sessions, which don’t run on this computer.
      </div>
      <Row
        label="Enable computer use"
        description={
          <>
            Let Claudex see and act in the apps you allow, working in the
            background or with full control of your screen.
            {learnMore && (
              <>
                {" "}
                <a
                  className="cu-link"
                  href={learnMore}
                  onClick={(event) => {
                    event.preventDefault();
                    void window.desktop.openExternal(learnMore).catch(onError);
                  }}
                >
                  Learn more
                </a>
              </>
            )}
          </>
        }
      >
        <Toggle
          label="Enable computer use"
          checked={enabled}
          onChange={(next) => {
            // Turning it on asks first (the original's "Turn on computer
            // use?"); turning it off does not.
            if (next) setConfirming(true);
            else save({ enabled: false });
          }}
        />
      </Row>
      {confirming && (
        <EnableComputerUseDialog
          platform={platform}
          permissions={permissions}
          learnMore={learnMore}
          onClose={() => setConfirming(false)}
          onError={onError}
        />
      )}
      {state.canHideApps && fullControlAllowed && (
        <Row
          label="Unhide apps when Claudex finishes"
          description="When Claudex has full control of your screen, apps hidden during a task are restored when Claudex stops."
        >
          <Toggle
            label="Unhide apps when Claudex finishes"
            checked={settings.unhideApps}
            disabled={!enabled}
            onChange={(unhideApps) => save({ unhideApps })}
          />
        </Row>
      )}
      <Row
        label="How Claudex uses the apps you allow"
        description={
          <>
            Background: Claudex works inside the apps you allow while you keep
            using your computer, and asks your permission before taking full
            control of your screen. Full control: Claudex takes control of your
            screen, mouse, and keyboard by default whenever Claudex uses an app
            you allow, without asking again.
            {!fullControlAllowed && (
              <> Your administrator doesn’t allow full control.</>
            )}
          </>
        }
      >
        <ModeControl
          value={fullControlAllowed ? settings.mode : "background"}
          disabled={!enabled}
          fullControlAllowed={fullControlAllowed}
          onChange={(mode) => save({ mode })}
        />
      </Row>
      <DeniedApps state={state} onError={onError} />
      {permissions && (
        <>
          <PermissionRow
            kind="accessibility"
            label="Accessibility"
            status={permissions.accessibility}
            attention={enabled}
            onError={onError}
          />
          <PermissionRow
            kind="screen"
            label="Screen recording"
            status={permissions.screen}
            attention={enabled}
            onError={onError}
          />
        </>
      )}
    </section>
  );
}

/** Background | Full control, the settings' segmented pill. */
function ModeControl({
  value,
  disabled,
  fullControlAllowed,
  onChange,
}: {
  value: ComputerUseSettings["mode"];
  disabled: boolean;
  fullControlAllowed: boolean;
  onChange: (mode: ComputerUseSettings["mode"]) => void;
}) {
  const options = [
    { value: "background" as const, label: "Background", off: false },
    {
      value: "fullControl" as const,
      label: "Full control",
      off: !fullControlAllowed,
    },
  ];
  return (
    <SegmentedControl
      className="settings-segmented cu-segmented"
      label="How Claudex uses the apps you allow"
      value={value}
      segments={options.map((option) => ({
        value: option.value,
        label: option.label,
        disabled: option.off,
      }))}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** Denied apps: Add app ⌄, the list, the empty line. */
function DeniedApps({
  state,
  onError,
}: {
  state: ComputerUseState;
  onError: (error: unknown) => void;
}) {
  const [apps, setApps] = useState<InstalledApp[]>();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Icons and names for the list come from the installed apps.
  useEffect(() => {
    let live = true;
    window.desktop
      .computerUseInstalledApps()
      .then((list) => live && setApps(list))
      .catch((error: unknown) => live && (setApps([]), onError(error)));
    return () => {
      live = false;
    };
  }, []);
  const byKey = useMemo(
    () => new Map((apps ?? []).map((app) => [appKey(app.id), app])),
    [apps],
  );
  const user = state.settings.deniedApps;
  const admin = (state.adminDeniedApps ?? []).filter(Boolean);
  const adminKeys = new Set(admin.map(appKey));
  const denied = new Set([
    ...admin.map(appKey),
    ...user.map((a) => appKey(a.id)),
  ]);
  const save = (deniedApps: ComputerUseAppRef[]) =>
    void saveComputerUseSettings({ deniedApps }).catch(onError);
  const empty = !user.length && !admin.length;
  return (
    <div className="cu-denied">
      <Row
        label="Denied apps"
        description="Any request Claudex makes to access these apps is automatically rejected. Claudex may still affect them indirectly through actions in allowed apps."
      >
        <button
          ref={trigger}
          type="button"
          className="settings-button cu-add-app"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Add app
          <ChevronDown size={12} />
        </button>
      </Row>
      {empty ? (
        <p className="cu-denied-empty">
          No apps denied. Add an app to automatically reject Claudex’s requests
          for it.
        </p>
      ) : (
        <ul className="cu-denied-list" aria-label="Denied apps">
          {admin.map((id) => {
            const app = byKey.get(appKey(id));
            return (
              <li key={`admin:${id}`}>
                <AppIcon icon={app?.icon} />
                <span className="cu-denied-name">{app?.name ?? id}</span>
                <span
                  className="cu-denied-admin"
                  title="Denied by your administrator"
                >
                  <Lock size={13} aria-hidden="true" />
                  Denied by your administrator
                </span>
              </li>
            );
          })}
          {user
            .filter((app) => !adminKeys.has(appKey(app.id)))
            .map((app) => (
              <li key={app.id}>
                <AppIcon icon={byKey.get(appKey(app.id))?.icon} />
                <span className="cu-denied-name">{app.name}</span>
                <button
                  type="button"
                  className="cu-denied-remove"
                  aria-label={`Remove ${app.name}`}
                  title="Remove"
                  onClick={() =>
                    save(user.filter((other) => other.id !== app.id))
                  }
                >
                  <X size={14} />
                </button>
              </li>
            ))}
        </ul>
      )}
      {open && (
        <AddAppMenu
          anchor={trigger}
          apps={apps}
          denied={denied}
          onPick={(app) => {
            setOpen(false);
            save([
              ...user,
              { id: app.id, name: app.name, platform: app.platform },
            ]);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function AppIcon({ icon }: { icon?: string }) {
  return icon ? (
    <img className="cu-app-icon" src={icon} alt="" />
  ) : (
    <span className="cu-app-icon cu-app-icon-blank" aria-hidden="true">
      <Monitor size={16} />
    </span>
  );
}

/** The installed apps, with a search field; picking one denies it. */
function AddAppMenu({
  anchor,
  apps,
  denied,
  onPick,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  apps: InstalledApp[] | undefined;
  denied: Set<string>;
  onPick: (app: InstalledApp) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useDismiss([box, anchor], true, onClose);
  // Arrow keys move the highlight; keep it in view in a long list.
  useEffect(() => {
    box.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const rect = anchor.current?.getBoundingClientRect();
  const shown = (apps ?? [])
    .filter((app) => !denied.has(appKey(app.id)))
    .filter((app) =>
      app.name.toLowerCase().includes(query.trim().toLowerCase()),
    );
  const place = rect
    ? {
        right: Math.max(8, innerWidth - rect.right),
        ...(rect.bottom + 6 + 320 <= innerHeight - 8
          ? { top: rect.bottom + 6 }
          : { bottom: Math.max(8, innerHeight - rect.top + 6) }),
      }
    : { right: 8, top: 8 };
  return createPortal(
    <div
      ref={box}
      className="cu-add-menu"
      role="dialog"
      aria-label="Add app"
      style={place}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          anchor.current?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((index) =>
            shown.length ? (index + step + shown.length) % shown.length : 0,
          );
        } else if (event.key === "Enter" && shown[active]) {
          event.preventDefault();
          onPick(shown[active]);
        }
      }}
    >
      <label className="cu-add-search">
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          value={query}
          placeholder="Search apps"
          aria-label="Search apps"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      </label>
      <div className="cu-add-list" role="listbox" aria-label="Apps">
        {!apps ? (
          <p className="cu-add-note">Loading apps…</p>
        ) : !shown.length ? (
          <p className="cu-add-note">
            {query.trim() ? "No matching apps" : "No apps found"}
          </p>
        ) : (
          shown.map((app, index) => (
            <button
              key={app.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className="cu-add-option"
              onMouseMove={() => setActive(index)}
              onClick={() => onPick(app)}
            >
              <AppIcon icon={app.icon} />
              <span>{app.name}</span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
