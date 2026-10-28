import { useCallback, useEffect, useRef, useState } from "react";
import { ListFilter } from "../../../ui/glyphs";
import { Spinner } from "../../../ui/Spinner";
import { type Routine } from "../../../../shared/routines";
import { repeatLabel, repeatOf } from "../../../../shared/routine-labels";
import {
  dismissalGroups,
  dismissalLabels,
  dismissalNeedsNote,
  findingStatusLabels,
  findingStatuses,
  severities,
  severityLabels,
  type DismissalReason,
  type FindingTriage,
  type SecurityFinding,
  type SecurityFindingsView,
} from "../../../../shared/security-review";
import {
  defaultFindingFilter,
  filterFindings,
  type FindingFilter,
} from "../../../../shared/security-review-export";
import { currentLocale, formatText, tf, useLocale } from "../../../i18n";
import { Menu, type MenuEntry } from "../../../ui/Menu";
import { Modal } from "../../../ui/Controls";
import { FindingDetail } from "./FindingDetail";
import { exportFindings, type ExportKind } from "./export-findings";
import "./security-findings.css";

/** "Oct 12, 9:00 AM". */
const when = (time: number) =>
  new Date(time).toLocaleString(currentLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const findingCount = (count: number) =>
  count === 1 ? "1 finding" : formatText("{count} findings", { count });

const isScanning = (routine: Routine) =>
  routine.lastRunStatus === "starting" || routine.lastRunStatus === "running";

type MenuKind = "filter" | "export" | "triage" | "finding-export";
const menuWidths: Record<MenuKind, number> = {
  filter: 176,
  export: 240,
  triage: 200,
  "finding-export": 240,
};
const menuLabels: Record<MenuKind, string> = {
  filter: "Filters",
  export: "Export all findings",
  triage: "Triage",
  "finding-export": "Export finding",
};

/** The three export rows, as the original words them. */
function exportEntries(
  all: boolean,
  run: (kind: ExportKind) => void,
): MenuEntry[] {
  return [
    {
      label: "Copy as Markdown",
      description: all
        ? "Copy all findings to clipboard"
        : "Copy finding details to clipboard",
      onSelect: () => run("copy-md"),
    },
    {
      label: "Download Markdown",
      description: "Save as .md file",
      onSelect: () => run("download-md"),
    },
    {
      label: "Download CSV",
      description: "Save as .csv file",
      onSelect: () => run("download-csv"),
    },
  ];
}

/** The Triage menu: Resolution, then the dismissal reasons in the original's groups. */
function triageEntries(
  fixed: () => void,
  dismiss: (reason: DismissalReason) => void,
): MenuEntry[] {
  const entries: MenuEntry[] = [
    { heading: "Resolution" },
    { label: "Mark as fixed", onSelect: fixed },
  ];
  for (const group of dismissalGroups) {
    entries.push({ separator: true }, { heading: group.heading });
    for (const reason of group.reasons)
      entries.push({
        label: dismissalLabels[reason],
        onSelect: () => dismiss(reason),
      });
  }
  return entries;
}

/**
 * A security-review routine's findings: the list with its filters, Export all
 * findings and Run scan; a finding opens to its detail, triage and export
 * (FindingDetail.tsx). The list comes from the routine's finished runs
 * (shared/security-review.ts), read each time this opens and whenever a run
 * changes.
 */
export default function SecurityFindings({
  routine: initial,
  runBlocked,
  onRun,
  onOpenConversation,
  onClose,
}: {
  routine: Routine;
  /** Why Run scan is off (routines turned off, or another task is running), if it is. */
  runBlocked?: string;
  onRun: (routine: Routine) => void;
  onOpenConversation: (id: string) => void;
  onClose: () => void;
}) {
  useLocale();
  const [routine, setRoutine] = useState(initial);
  const [view, setView] = useState<SecurityFindingsView>();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FindingFilter>(defaultFindingFilter);
  const [selected, setSelected] = useState<string>();
  const [menu, setMenu] = useState<{ kind: MenuKind; rect: DOMRect }>();
  /** The dismissal reason that asks for a note first. */
  const [dismissing, setDismissing] = useState<DismissalReason>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(
    () =>
      window.desktop
        .securityFindings(initial.id)
        .then((value) => {
          setView(value);
          setError("");
        })
        .catch((reason) => {
          setView((current) => current ?? { findings: [], scans: [] });
          setError(reason instanceof Error ? reason.message : String(reason));
        }),
    [initial.id],
  );
  useEffect(() => {
    void load();
    // A run starting or ending changes the routine: its state and findings.
    const off = window.desktop.onEvent((event) => {
      if (event.type !== "schedules") return;
      const current = event.schedules.find((task) => task.id === initial.id);
      if (current) setRoutine(current);
      void load();
    });
    return () => {
      off();
      clearTimeout(statusTimer.current);
    };
  }, [initial.id, load]);

  const context = { routine: routine.name, folder: routine.cwd };
  const say = (text: string) => {
    setStatus(text);
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 3000);
  };
  const runExport = (
    kind: ExportKind,
    list: SecurityFinding[],
    single?: SecurityFinding,
  ) => {
    if (!list.length) return say("No findings to export");
    exportFindings(kind, list, context, single)
      .then((result) => {
        if (result === "copied") say("Copied to clipboard");
        else if (result === "saved") say("Saved");
      })
      .catch(() =>
        say(
          kind === "copy-md"
            ? "Couldn’t copy to the clipboard."
            : "Couldn’t save the file.",
        ),
      );
  };
  /** Rejects when the change could not be made (the message is shown). */
  async function triage(finding: SecurityFinding, change: FindingTriage) {
    setBusy(true);
    try {
      setView(
        await window.desktop.triageSecurityFinding(
          routine.id,
          finding.id,
          change,
        ),
      );
      setError("");
      say(change.status === "open" ? "Finding restored." : "Finding triaged.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }

  const findings = view?.findings ?? [];
  const listed = filterFindings(findings, filter);
  const filtering = filter.severity !== "all" || filter.status !== "all";
  const finding = findings.find((value) => value.id === selected);
  const scanning = isScanning(routine);
  const lastScan = view?.scans.find((scan) => scan.readable);
  const unreadable = view?.scans[0] && !view.scans[0].readable;
  const runOff =
    runBlocked ?? (routine.cwd ? undefined : "Choose a folder to review.");

  const openMenu = (kind: MenuKind, element: HTMLElement | null) => {
    if (!element) return;
    anchor.current = element;
    setMenu(
      menu?.kind === kind
        ? undefined
        : { kind, rect: element.getBoundingClientRect() },
    );
  };
  const entries = (kind: MenuKind): MenuEntry[] => {
    if (kind === "filter")
      return [
        { heading: "Severity" },
        {
          label: "All severities",
          checked: filter.severity === "all",
          onSelect: () => setFilter({ ...filter, severity: "all" }),
        },
        ...severities.map((value) => ({
          label: severityLabels[value],
          checked: filter.severity === value,
          onSelect: () => setFilter({ ...filter, severity: value }),
        })),
        { separator: true },
        { heading: "Status" },
        {
          label: "All statuses",
          checked: filter.status === "all",
          onSelect: () => setFilter({ ...filter, status: "all" }),
        },
        ...findingStatuses.map((value) => ({
          label: findingStatusLabels[value],
          checked: filter.status === value,
          onSelect: () => setFilter({ ...filter, status: value }),
        })),
      ];
    if (kind === "export")
      return exportEntries(true, (how) => runExport(how, listed));
    if (!finding) return [];
    if (kind === "finding-export")
      return exportEntries(false, (how) => runExport(how, [finding], finding));
    return triageEntries(
      () => void triage(finding, { status: "fixed" }).catch(() => {}),
      (reason) => {
        if (dismissalNeedsNote(reason)) setDismissing(reason);
        else
          void triage(finding, { status: "dismissed", reason }).catch(() => {});
      },
    );
  };

  const width = menu ? menuWidths[menu.kind] : 0;
  return (
    <>
      <Modal
        title={formatText("Findings for {routine}", { routine: routine.name })}
        // Escape closes the note dialog over it first, not both.
        onClose={() => !dismissing && onClose()}
        wide
      >
        <div className="sec-findings">
          {view === undefined ? (
            <div className="sec-loading" aria-label="Loading findings">
              <Spinner inheritColor size={16} className="spin" />
            </div>
          ) : finding ? (
            <FindingDetail
              finding={finding}
              busy={busy}
              status={status}
              error={error}
              onBack={() => setSelected(undefined)}
              onTriageMenu={(button) => openMenu("triage", button)}
              onExportMenu={(button) => openMenu("finding-export", button)}
              onRestore={() =>
                void triage(finding, { status: "open" }).catch(() => {})
              }
            />
          ) : (
            <>
              <div className="sec-toolbar">
                <div className="sec-counts">
                  <p className="sec-summary">
                    {scanning ? (
                      <>
                        <Spinner inheritColor size={12} className="spin" />{" "}
                        Scanning…
                      </>
                    ) : lastScan ? (
                      formatText(
                        lastScan.branch
                          ? "Last scan {when} on {branch}"
                          : "Last scan {when}",
                        {
                          when: when(lastScan.at),
                          branch: lastScan.branch ?? "",
                        },
                      )
                    ) : null}
                  </p>
                  <p className="sec-schedule">
                    {tf(
                      "Rescans this branch on a schedule ({schedule}) with the same model and effort.",
                      {
                        schedule: repeatLabel(
                          repeatOf(routine),
                          currentLocale(),
                        ),
                      },
                    )}
                  </p>
                </div>
                <div className="sec-tools">
                  <button
                    type="button"
                    className="sec-tool"
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === "filter"}
                    aria-label={filtering ? "Filters (active)" : "Filters"}
                    data-active={filtering || undefined}
                    onClick={(event) => openMenu("filter", event.currentTarget)}
                  >
                    <ListFilter size={15} strokeWidth={1.6} />
                  </button>
                  <button
                    type="button"
                    className="secondary sec-button"
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === "export"}
                    onClick={(event) => openMenu("export", event.currentTarget)}
                  >
                    Export all findings
                  </button>
                  <button
                    type="button"
                    className="secondary sec-button"
                    disabled={Boolean(runOff) || scanning}
                    title={runOff}
                    onClick={() => onRun(routine)}
                  >
                    Run scan
                  </button>
                </div>
              </div>
              {status && (
                <p className="sec-status-line" role="status">
                  {status}
                </p>
              )}
              {error && (
                <p className="routine-error" role="alert">
                  {error}
                </p>
              )}
              {unreadable && !scanning && (
                <p className="sec-banner">
                  <span>
                    The last run didn’t answer with a findings report, so the
                    list is unchanged.
                  </span>
                  {routine.conversationId && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenConversation(routine.conversationId!);
                      }}
                    >
                      Open last run
                    </button>
                  )}
                </p>
              )}
              {listed.length ? (
                <>
                  <p className="sec-count">{findingCount(listed.length)}</p>
                  <ul className="sec-list" aria-label="Findings">
                    {listed.map((value) => (
                      <li key={value.id}>
                        <button
                          type="button"
                          className="sec-row"
                          onClick={() => setSelected(value.id)}
                        >
                          <span className={`sec-severity ${value.severity}`}>
                            {severityLabels[value.severity]}
                          </span>
                          <span className="sec-row-text">
                            <strong data-no-translate>{value.title}</strong>
                            {value.file && (
                              <small data-no-translate>
                                {value.start === undefined
                                  ? value.file
                                  : `${value.file}:${value.start}`}
                              </small>
                            )}
                          </span>
                          <span className={`sec-status ${value.status}`}>
                            {findingStatusLabels[value.status]}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="sec-empty" role="status">
                  {findings.length
                    ? "No findings match your filters."
                    : scanning
                      ? "Scan in progress. Results will appear here."
                      : view.scans.some((scan) => scan.readable)
                        ? "No findings detected"
                        : "Run a scan to see findings."}
                </p>
              )}
              {filtering && findings.length > 0 && (
                <button
                  type="button"
                  className="sec-clear"
                  onClick={() => setFilter(defaultFindingFilter)}
                >
                  Clear filters
                </button>
              )}
            </>
          )}
        </div>
        {menu && (
          <Menu
            label={menuLabels[menu.kind]}
            width={width}
            size="regular"
            position={{
              top: menu.rect.bottom + 4,
              left: Math.max(8, menu.rect.right - width),
            }}
            anchors={[anchor]}
            entries={entries(menu.kind)}
            onClose={() => setMenu(undefined)}
          />
        )}
      </Modal>
      {dismissing && finding && (
        <DismissDialog
          reason={dismissing}
          busy={busy}
          error={error}
          onClose={() => setDismissing(undefined)}
          onSubmit={(note) =>
            triage(finding, {
              status: "dismissed",
              reason: dismissing,
              note,
            }).then(
              () => setDismissing(undefined),
              () => {},
            )
          }
        />
      )}
    </>
  );
}

/** Accepting a risk, or dismissing for another reason, asks why first. */
function DismissDialog({
  reason,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  reason: DismissalReason;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const accepted = reason === "accepted_risk";
  return (
    <Modal
      title={accepted ? "Dismiss as accepted risk" : "Dismiss finding"}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() && !busy) void onSubmit(text.trim());
        }}
      >
        <label>
          Note
          <textarea
            rows={3}
            value={text}
            disabled={busy}
            placeholder={
              accepted
                ? "Explain why this risk is being accepted and any mitigating factors."
                : "Explain why this finding is being dismissed."
            }
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <p className="sec-help">
          A note is required for this dismissal reason.
        </p>
        {error && (
          <p className="routine-error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!text.trim() || busy}
          >
            Dismiss
          </button>
        </div>
      </form>
    </Modal>
  );
}
