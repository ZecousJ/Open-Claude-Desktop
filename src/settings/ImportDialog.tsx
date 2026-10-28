import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import {
  formatSize,
  historyRanges,
  rangeStart,
  tallyHistory,
  type HistoryImportResult,
  type HistoryRange,
  type HistorySource,
  type HistorySourceProblem,
  type HistoryTally,
} from "../../shared/history-import";
import { formatText, useT } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SettingsModal } from "./controls";
import "./import-history.css";

/** One count with its noun, in the singular when it is one. */
export function countText(
  n: number,
  one: string,
  other: string,
  values: Record<string, string | number> = {},
) {
  return formatText(n === 1 ? one : other, { ...values, n });
}

/** A sentence with its number set in bold (the original's <b>#</b>). */
function BoldNumber({ text, bold }: { text: string; bold: number | string }) {
  const at = text.indexOf(String(bold));
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong>{bold}</strong>
      {text.slice(at + String(bold).length)}
    </>
  );
}

/** What the picker refused, in the original's words for its folder import. */
export function problemText(
  problem: HistorySourceProblem,
  kind: "file" | "folder",
) {
  if (problem === "self")
    return "That’s this app’s own data folder. Choose a different one.";
  if (problem === "unknown-shape")
    return kind === "folder"
      ? "Couldn’t find conversations in that folder. Choose the app’s data folder (its name starts with “Claudex”)."
      : "Couldn’t find conversations in that file. Choose an export saved from Settings → Privacy → Export data.";
  return kind === "folder"
    ? "Couldn’t read that folder."
    : "Couldn’t read that file.";
}

/** Adds up what each included location would bring. */
export function totalTally(tallies: (HistoryTally | null)[]): HistoryTally {
  const total: HistoryTally = {
    conversations: 0,
    projects: 0,
    sizeBytes: 0,
    outOfWindow: 0,
    alreadyImported: 0,
  };
  for (const tally of tallies)
    if (tally)
      for (const key of Object.keys(total) as (keyof HistoryTally)[])
        total[key] += tally[key];
  return total;
}

type Phase = "review" | "importing" | "success" | "error";

/**
 * Import from Claudex (Settings → Import): the locations to copy from, how far
 * back to go, and what that adds, then the result. The list and the wording
 * follow the original's local session import: a card per location with a
 * checkbox, "Added by you" and a remove button, a dashed "Add another
 * location…", and the note that a copy never duplicates. Claudex has no
 * location to look in by itself, so the list starts empty.
 */
export function ImportDialog({
  onClose,
  onError,
}: {
  onClose: (imported: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [sources, setSources] = useState<HistorySource[] | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [range, setRange] = useState<HistoryRange>("30d");
  const [refusal, setRefusal] = useState<{
    problem: HistorySourceProblem;
    kind: "file" | "folder";
  }>();
  const [phase, setPhase] = useState<Phase>("review");
  const [result, setResult] = useState<HistoryImportResult>();
  const [menu, setMenu] = useState<MenuPosition>();
  const [now] = useState(() => Date.now());
  const add = useRef<HTMLButtonElement>(null);
  const since = rangeStart(range, now);
  const imported = useRef(false);

  useEffect(() => {
    let current = true;
    window.desktop
      .importSources()
      // A bridge with no answer (an older runner, a fixture) is an empty list.
      .then((list) => current && setSources(list ?? []))
      .catch((error) => {
        if (!current) return;
        setSources([]);
        onError(error);
      });
    return () => {
      current = false;
    };
  }, []);

  const tallies = useMemo(
    () =>
      new Map(
        (sources ?? []).map((source) => [
          source.id,
          source.scan ? tallyHistory(source.scan, since) : null,
        ]),
      ),
    [sources, since],
  );
  const included = (sources ?? []).filter((source) => !excluded.has(source.id));
  const total = totalTally(
    included.map((source) => tallies.get(source.id) ?? null),
  );
  const anything = total.conversations + total.projects > 0;

  const pick = (kind: "file" | "folder") => {
    setMenu(undefined);
    setRefusal(undefined);
    window.desktop
      .importAddSource(kind)
      .then((added) => {
        if (!added) return;
        if ("problem" in added)
          return setRefusal({ problem: added.problem, kind });
        setSources((list) => [
          ...(list ?? []).filter((source) => source.id !== added.source.id),
          added.source,
        ]);
        setExcluded((ids) => {
          const next = new Set(ids);
          next.delete(added.source.id);
          return next;
        });
      })
      .catch(onError);
  };
  const run = () => {
    setPhase("importing");
    window.desktop
      .importRun(
        included.map((source) => source.id),
        since,
      )
      .then((outcome) => {
        imported.current =
          outcome.imported.conversations + outcome.imported.projects > 0;
        setResult(outcome);
        setPhase(outcome.ok ? "success" : "error");
      })
      .catch((error) => {
        onError(error);
        setPhase("error");
      });
  };
  const close = () => onClose(imported.current);

  return (
    <SettingsModal
      title={t("Import from Claudex")}
      className="import-dialog"
      onClose={close}
    >
      <p className="import-subtitle">
        {t("Bring over your conversations and projects")}
      </p>
      {phase === "importing" && (
        <div className="import-progress" role="status">
          <h3>{t("Importing…")}</h3>
        </div>
      )}
      {phase === "success" && result && <ImportSuccess result={result} />}
      {phase === "error" && (
        <div className="import-failed">
          <h3>
            <AppIcon name="Warning" size={18} aria-hidden="true" />
            {t("Import failed")}
          </h3>
          <p>{t("Nothing was imported. Try again from Settings → Import.")}</p>
        </div>
      )}
      {phase === "review" && (
        <div>
          <h3>{t("Claudex conversations")}</h3>
          <p className="import-lead">
            {t(
              "Pick how far back to go. Everything from the sources below in that window is copied over.",
            )}
          </p>
          <SegmentedControl
            className="import-range"
            label={t("Import conversations from")}
            value={range}
            segments={historyRanges.map(({ id, label }) => ({
              value: id,
              label: t(label),
            }))}
            onChange={setRange}
          />
          <p className="import-rollup" data-testid="import-rollup">
            <Rollup total={total} />
          </p>
          <div className="import-sources">
            {sources === null ? (
              <p className="import-empty" role="status">
                {t("Scanning…")}
              </p>
            ) : (
              <>
                {sources.length === 0 && (
                  <div className="import-empty">
                    <strong>{t("No locations added yet")}</strong>
                    <p>
                      {t(
                        "If your conversations are on another computer, save an export there (Settings → Privacy → Export data) or copy the app’s data folder over, and choose it below.",
                      )}
                    </p>
                  </div>
                )}
                {sources.map((source) => (
                  <SourceCard
                    key={source.id}
                    source={source}
                    tally={tallies.get(source.id) ?? null}
                    included={!excluded.has(source.id)}
                    onToggle={(on) =>
                      setExcluded((ids) => {
                        const next = new Set(ids);
                        if (on) next.delete(source.id);
                        else next.add(source.id);
                        return next;
                      })
                    }
                    onRemove={() => {
                      setSources((list) =>
                        (list ?? []).filter((value) => value.id !== source.id),
                      );
                      window.desktop
                        .importRemoveSource(source.id)
                        .catch(onError);
                    }}
                  />
                ))}
              </>
            )}
            <button
              ref={add}
              type="button"
              className="import-add"
              data-testid="import-add-source"
              aria-haspopup="menu"
              aria-expanded={Boolean(menu)}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ left: box.left, top: box.bottom + 4 });
              }}
            >
              <span className="import-add-icon">
                <Plus size={16} aria-hidden="true" />
              </span>
              <span>
                <span className="import-add-title">
                  {t("Add another location…")}
                </span>
                <span className="import-add-note">
                  {t("A backup or a folder copied from another machine")}
                </span>
              </span>
            </button>
            {menu && (
              <Menu
                label={t("Add another location…")}
                entries={[
                  {
                    label: t("Export file (.zip)…"),
                    onSelect: () => pick("file"),
                  },
                  {
                    label: t("Data folder…"),
                    onSelect: () => pick("folder"),
                  },
                ]}
                position={menu}
                width={200}
                anchors={[add]}
                onClose={() => setMenu(undefined)}
              />
            )}
          </div>
          {refusal && (
            <p className="import-refusal" role="alert">
              <AppIcon name="Warning" size={16} aria-hidden="true" />
              {t(problemText(refusal.problem, refusal.kind))}
            </p>
          )}
          <p className="import-footnote">
            {t(
              "Conversations are copied, not moved — the original stays where it is, and re-importing won’t create duplicates.",
            )}
          </p>
        </div>
      )}
      <div className="button-row">
        {phase === "success" ? (
          <button type="button" className="primary" onClick={close}>
            {t("Done")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              disabled={phase === "importing"}
              onClick={close}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="primary"
              data-testid="import-run"
              disabled={
                phase === "importing" ||
                (phase === "review" && (!anything || sources === null))
              }
              onClick={run}
            >
              {phase === "error" ? t("Try again") : t("Import")}
            </button>
          </>
        )}
      </div>
    </SettingsModal>
  );
}

/** "N conversations in this range · size", and what is already here. */
function Rollup({ total }: { total: HistoryTally }) {
  const t = useT();
  const here = total.conversations + total.alreadyImported;
  if (here === 0)
    return <BoldNumber text={t("0 conversations in this range")} bold={0} />;
  if (total.alreadyImported === 0)
    return (
      <BoldNumber
        text={countText(
          total.conversations,
          "{n} conversation in this range · {size}",
          "{n} conversations in this range · {size}",
          { size: formatSize(total.sizeBytes) },
        )}
        bold={total.conversations}
      />
    );
  return (
    <BoldNumber
      text={formatText("{total} in this range · {fresh} new · {size}", {
        total: here,
        fresh: total.conversations,
        size: formatSize(total.sizeBytes),
      })}
      bold={here}
    />
  );
}

function SourceCard({
  source,
  tally,
  included,
  onToggle,
  onRemove,
}: {
  source: HistorySource;
  tally: HistoryTally | null;
  included: boolean;
  onToggle: (included: boolean) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const count = tally ? tally.conversations + tally.alreadyImported : 0;
  const empty = tally !== null && count === 0 && tally.outOfWindow === 0;
  return (
    <div
      className={`import-source ${empty || !included ? "dim" : ""}`}
      data-testid="import-source-card"
    >
      <input
        type="checkbox"
        className="cx-check-input"
        checked={included}
        aria-label={formatText("Include conversations from {name}", {
          name: source.label,
        })}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <div className="import-source-text">
        <div className="import-source-title">
          <span title={source.path}>{source.label}</span>
          <span className="import-source-count">
            {"· "}
            {source.problem ? (
              t("Unreadable")
            ) : tally === null ? (
              t("Scanning…")
            ) : (
              <BoldNumber
                text={countText(count, "{n} conversation", "{n} conversations")}
                bold={count}
              />
            )}
          </span>
        </div>
        <div className="import-source-path" title={source.path}>
          {source.path}
        </div>
        <SourceNote source={source} tally={tally} />
      </div>
      <div className="import-source-end">
        <span className="import-badge">{t("Added by you")}</span>
        <button
          type="button"
          className="import-source-remove"
          aria-label={t("Remove this source")}
          onClick={onRemove}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The line under a location: a problem, or how much of it is already here. */
function SourceNote({
  source,
  tally,
}: {
  source: HistorySource;
  tally: HistoryTally | null;
}) {
  const t = useT();
  let note: string | undefined;
  if (source.problem)
    note = t("Couldn’t read this folder. Remove it and try again.");
  else if (tally) {
    if (
      tally.conversations === 0 &&
      tally.alreadyImported > 0 &&
      tally.outOfWindow === 0
    )
      note = formatText("All {n} already imported", {
        n: tally.alreadyImported,
      });
    else if (tally.conversations === 0 && tally.outOfWindow > 0)
      note = countText(
        tally.outOfWindow,
        "{n} older conversation — widen the range to include it",
        "{n} older conversations — widen the range to include them",
      );
    else if (tally.alreadyImported > 0)
      note = formatText("{n} already imported", { n: tally.alreadyImported });
  }
  return note ? <div className="import-source-note">{note}</div> : null;
}

function ImportSuccess({ result }: { result: HistoryImportResult }) {
  const t = useT();
  const { conversations, projects } = result.imported;
  return (
    <div className="import-success" data-testid="import-wizard-success">
      <span className="import-success-mark">
        <Check size={22} aria-hidden="true" />
      </span>
      <h3>
        {countText(
          conversations,
          "Imported {n} conversation",
          "Imported {n} conversations",
        )}
        {projects > 0 &&
          ` · ${countText(projects, "{n} project", "{n} projects")}`}
      </h3>
      {result.failed > 0 && (
        <p className="warning">
          {countText(
            result.failed,
            "{n} location couldn’t be read.",
            "{n} locations couldn’t be read.",
          )}
        </p>
      )}
      {result.skipped > 0 && (
        <p>
          {countText(
            result.skipped,
            "{n} conversation was already imported and skipped.",
            "{n} conversations were already imported and skipped.",
          )}
        </p>
      )}
      <p>
        {t(
          "Find them in the sidebar. Re-running import won’t create duplicates.",
        )}
      </p>
    </div>
  );
}
