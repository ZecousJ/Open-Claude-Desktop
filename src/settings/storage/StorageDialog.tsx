import { useEffect, useRef, useState, type ReactNode } from "react";
import { Folder } from "../../ui/glyphs";
import { formatText, t, useT } from "../../i18n";
import { relativeTime } from "../../ui/RelativeTime";
import { AppIcon } from "../../ui/app-icon";
import { Collapsible } from "../../ui/Collapsible";
import { Skeleton, SkeletonGroup } from "../../ui/Skeleton";
import { showToast } from "../../ui/toast-store";
import { SettingsModal } from "../controls";
import type {
  StorageCleanupKind,
  StorageUsage,
} from "../../../shared/settings-desktop-api";
import { CleanupDialog } from "./CleanupDialog";
import {
  codeSummary,
  coworkSummary,
  runtimeSummary,
  storageAreas,
  storageSize,
} from "./storage-text";
import "./storage.css";

type Loaded =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; value: StorageUsage; refreshing: boolean };

/** How much of a bar each kind takes: the first in full, the rest fading. */
const shades = [1, 0.72, 0.5, 0.32, 0.2];

interface Kind {
  id: string;
  label: string;
  bytes: number;
  /** "Other": drawn in the muted colour, not a shade. */
  muted?: boolean;
}

/** A bar of kinds and its legend. */
function KindBar({ label, kinds }: { label: string; kinds: Kind[] }) {
  const shown = kinds.filter((kind) => kind.bytes > 0);
  if (!shown.length) return null;
  const total = shown.reduce((sum, kind) => sum + kind.bytes, 0);
  let shade = 0;
  const painted = shown.map((kind) => ({
    ...kind,
    style: kind.muted
      ? undefined
      : { opacity: shades[Math.min(shade++, shades.length - 1)] },
  }));
  return (
    <div className="storage-kinds">
      <div
        className="storage-bar"
        role="img"
        aria-label={`${t(label)}: ${painted
          .map((kind) => `${t(kind.label)} ${storageSize(kind.bytes)}`)
          .join("; ")}`}
      >
        {painted.map((kind) => (
          <div
            key={kind.id}
            className={kind.muted ? "muted" : undefined}
            style={{ width: `${(kind.bytes / total) * 100}%`, ...kind.style }}
          />
        ))}
      </div>
      <ul className="storage-legend">
        {painted.map((kind) => (
          <li key={kind.id}>
            <span
              aria-hidden="true"
              className={kind.muted ? "muted" : undefined}
              style={kind.style}
            />
            <span className="storage-legend-label">{kind.label}</span>
            <span className="storage-legend-size">
              {storageSize(kind.bytes)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Details" that opens an area's kinds and its cleanup. */
function Details({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="storage-details">
      <button
        type="button"
        className="storage-details-trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AppIcon name="CaretRight" />
        Details
      </button>
      <Collapsible open={open}>
        <div className="storage-details-panel">{children}</div>
      </Collapsible>
    </div>
  );
}

/** A row of the dialog: label and description, the size, and what opens below. */
function Area({
  label,
  description,
  size,
  strong,
  children,
}: {
  label: string;
  description: ReactNode;
  size?: string;
  strong?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="storage-area">
      <div className="storage-area-head">
        <div className="storage-area-text">
          <div className="storage-area-label">{label}</div>
          <div className="storage-area-description">{description}</div>
        </div>
        {size !== undefined && (
          <span className={`storage-size${strong ? " strong" : ""}`}>
            {size}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Settings → System → Storage: the space Claudex uses on this computer, the
 * area bar, then Cowork tasks, Code sessions, Runtime and App caches and logs,
 * each with Details and its own cleanup, and Open folder and Refresh.
 */
export function StorageDialog({ onClose }: { onClose: () => void }) {
  useT();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [cleanup, setCleanup] = useState<StorageCleanupKind | null>(null);
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    window.desktop.storageUsage().then(
      (value) => {
        if (id === request.current)
          setState({ status: "ready", value, refreshing: false });
      },
      () => {
        if (id !== request.current) return;
        setState((current) =>
          current.status === "ready"
            ? { ...current, refreshing: false }
            : { status: "error" },
        );
        showToast(t("Couldn’t calculate storage. Try again."));
      },
    );
  };
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, []);
  const refresh = () => {
    setState((current) =>
      current.status === "ready"
        ? { ...current, refreshing: true }
        : { status: "loading" },
    );
    load();
  };
  const clearCache = () =>
    void window.desktop
      .clearCacheAndRestart({
        message: formatText("Clear cached web content and restart Claudex?"),
        detail: t(
          "You stay signed in. Open conversations and tasks are kept; the app closes and reopens.",
        ),
        cancel: t("Cancel"),
        confirm: t("Clear and restart"),
      })
      .catch(() => showToast(t("Error clearing cache")));
  const busy =
    state.status === "loading" ||
    (state.status === "ready" && state.refreshing);
  return (
    <>
      <SettingsModal
        title="Storage"
        className="storage-dialog"
        // Escape closes the cleanup over it first.
        onClose={() => {
          if (!cleanup) onClose();
        }}
      >
        <p className="desktop-dialog-note">
          Space Claudex uses on this computer. Cowork tasks that run in the
          cloud aren’t included.
        </p>
        <div className="storage-areas" aria-busy={busy || undefined}>
          {state.status === "loading" ? (
            <SkeletonGroup className="storage-loading">
              <Skeleton height={20} width="33%" />
              <Skeleton height={8} />
              <Skeleton height={20} width="66%" />
              <Skeleton height={20} width="50%" />
            </SkeletonGroup>
          ) : state.status === "error" ? (
            <Area
              label="Disk space used"
              description="Couldn’t calculate storage. Try again."
            />
          ) : (
            <Usage
              usage={state.value}
              onCleanup={setCleanup}
              onClearCache={clearCache}
            />
          )}
        </div>
        <div className="button-row storage-actions">
          <button
            type="button"
            className="storage-ghost"
            onClick={() =>
              void window.desktop
                .revealDataFolder()
                .catch((error) =>
                  showToast(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
            }
          >
            <Folder size={16} aria-hidden="true" />
            Open folder
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={refresh}
          >
            <AppIcon name="ArrowClockwise" />
            Refresh
          </button>
        </div>
      </SettingsModal>
      {cleanup && (
        <CleanupDialog
          kind={cleanup}
          onClose={() => setCleanup(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}

/** The measured areas (exported for the tests). */
export function Usage({
  usage,
  onCleanup,
  onClearCache,
}: {
  usage: StorageUsage;
  onCleanup: (kind: StorageCleanupKind) => void;
  onClearCache: () => void;
}) {
  const areas = storageAreas(usage);
  const total = areas.cowork + areas.code + areas.runtime + areas.app;
  const { cowork, code, runtime, app } = usage;
  return (
    <>
      <Area
        label="Disk space used"
        description={
          usage.incomplete
            ? "Some folders couldn’t be measured, so this is a lower bound."
            : formatText("Calculated {when}.", {
                when: relativeTime(usage.computedAt),
              })
        }
        size={storageSize(total)}
        strong
      >
        <KindBar
          label="Storage by area"
          kinds={[
            { id: "cowork", label: "Cowork tasks", bytes: areas.cowork },
            {
              id: "code",
              label: "Code sessions and worktrees",
              bytes: areas.code,
            },
            { id: "runtime", label: "Runtime", bytes: areas.runtime },
            {
              id: "app",
              label: "App caches and logs",
              bytes: areas.app,
              muted: true,
            },
          ]}
        />
      </Area>
      <Area
        label="Cowork tasks"
        description={coworkSummary(usage)}
        size={storageSize(areas.cowork)}
      >
        {(areas.cowork > 0 || cowork.stale.count > 0) && (
          <Details label={t("Cowork task details")}>
            <KindBar
              label="Cowork storage by kind"
              kinds={[
                {
                  id: "history",
                  label: "Task history",
                  bytes: cowork.historyBytes,
                },
                {
                  id: "files",
                  label: "Attachments and generated files",
                  bytes: cowork.filesBytes,
                },
                {
                  id: "shared",
                  label: "Plugins and skills",
                  bytes: cowork.pluginsAndSkillsBytes,
                },
                {
                  id: "workspace",
                  label: "Workspace",
                  bytes: cowork.workspaceBytes,
                },
                {
                  id: "other",
                  label: "Other",
                  bytes: cowork.otherBytes,
                  muted: true,
                },
              ]}
            />
            {cowork.stale.count > 0 && (
              <div className="storage-cleanup-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onCleanup("cowork")}
                >
                  Free up space…
                </button>
              </div>
            )}
          </Details>
        )}
      </Area>
      <Area
        label="Code sessions and worktrees"
        description={codeSummary(usage)}
        size={storageSize(areas.code)}
      >
        {(areas.code > 0 || code.sessionCount > 0) && (
          <Details label={t("Code session details")}>
            <KindBar
              label="Code storage by kind"
              kinds={[
                {
                  id: "history",
                  label: "Conversation history",
                  bytes: code.historyBytes,
                },
                {
                  id: "scratch",
                  label: "Scratch files",
                  bytes: code.scratchBytes,
                },
              ]}
            />
            {code.sessionCount > 0 && (
              <div className="storage-cleanup-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onCleanup("code")}
                >
                  Clean up inactive sessions…
                </button>
              </div>
            )}
          </Details>
        )}
      </Area>
      <Area
        label="Runtime"
        description={runtimeSummary(usage)}
        size={storageSize(areas.runtime)}
      >
        {areas.runtime > 0 && (
          <Details label={t("Runtime details")}>
            <KindBar
              label="Runtime storage by kind"
              kinds={[{ id: "codex", label: "Codex", bytes: runtime.bytes }]}
            />
          </Details>
        )}
      </Area>
      <Area
        label="App caches and logs"
        description="Web cache, browser panes and logs."
        size={storageSize(areas.app)}
      >
        <Details label={t("App cache details")}>
          <KindBar
            label="App storage by kind"
            kinds={[
              { id: "web", label: "Web cache", bytes: app.webCacheBytes },
              {
                id: "panes",
                label: "Browser panes",
                bytes: app.browserPanesBytes,
              },
              { id: "logs", label: "Logs", bytes: app.logsBytes },
              { id: "other", label: "Other", bytes: app.otherCachesBytes },
            ]}
          />
          <div className="storage-cleanup-row">
            <button type="button" className="secondary" onClick={onClearCache}>
              Clear cache and restart…
            </button>
          </div>
        </Details>
      </Area>
    </>
  );
}
