import { Suspense, useState } from "react";
import { Download, Upload } from "../../ui/glyphs";
import type {
  HistoryImportRun,
  HistoryRemovePreview,
} from "../../../shared/history-import";
import { formatText, useLocale, useT } from "../../i18n";
import { showToast } from "../../ui/toast-store";
import { Button, Row, Section, SettingsModal } from "../controls";
import type { TabProps } from "../context";
import { countText, ImportDialog } from "../ImportDialog";
import { useLoaded } from "../pageControls";
import "../desktop.css";
import "../import-history.css";
import { SkillImport } from "../SkillImport";
import { useHostCapability } from "../../host/HostContext";
import { lazyPiece } from "../../ui/lazy-piece";
import { usePolicy } from "../../policy/PolicyContext";

const LocalMcpImportDialog = lazyPiece(
  () => import("../LocalMcpImportDialog"),
  "LocalMcpImportDialog",
);

const CliImportDialog = lazyPiece(
  () => import("../CliImportDialog"),
  "CliImportDialog",
);

/** Rows Settings search finds on this page. */
export { importLabels as searchLabels } from "./desktop-labels";

/** What a run came from, named as the original names its sources. */
export function runSourceName(run: HistoryImportRun) {
  return run.source.kind === "file" ? "Claudex export" : "Claudex data folder";
}

/** A run's counts ("3 conversations, 1 project"). */
export function runCounts(counts: HistoryImportRun["counts"]) {
  const conversations = countText(
    counts.conversations,
    "{n} conversation",
    "{n} conversations",
  );
  return counts.projects > 0
    ? `${conversations}, ${countText(counts.projects, "{n} project", "{n} projects")}`
    : conversations;
}

/**
 * Import (desktop app only): bringing conversations and projects over from
 * a Claudex export or a data folder copied from another computer, and the
 * Import history of what earlier runs added, each with Remove (desktop
 * bundle 2.31226.1, the Import settings page). An import is a one-time
 * copy; Remove deletes what that run added.
 */
export function ImportTab(props: TabProps) {
  const desktop = useHostCapability("systemIntegration");
  return desktop ? (
    <DesktopImportTab {...props} />
  ) : (
    <div className="desktop-page import-page">
      <SkillImport
        onError={props.onError}
        onSkills={() => props.goTo("skills")}
      />
    </div>
  );
}

function DesktopImportTab({ onError, goTo, platform }: TabProps) {
  const policy = usePolicy();
  const [mcpImport, setMcpImport] = useState(false);
  const t = useT();
  useLocale();
  const history = useLoaded(() => window.desktop.importHistory(), onError);
  const [wizard, setWizard] = useState(false);
  const [cliImport, setCliImport] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [removing, setRemoving] = useState<{
    target: HistoryImportRun | "*";
    preview: HistoryRemovePreview | null;
  }>();
  const [busy, setBusy] = useState<string>();
  const runs = history.value ?? [];

  const ask = (target: HistoryImportRun | "*") => {
    setRemoving({ target, preview: null });
    window.desktop
      .importRemovePreview(target === "*" ? "*" : target.runId)
      .then((preview) =>
        setRemoving((current) =>
          current?.target === target ? { target, preview } : current,
        ),
      )
      .catch(() => {});
  };
  const remove = (target: HistoryImportRun | "*") => {
    const id = target === "*" ? "*" : target.runId;
    setRemoving(undefined);
    setBusy(id);
    window.desktop
      .importRemove(id)
      .then((outcome) =>
        showToast(
          outcome.failed > 0
            ? formatText(
                outcome.failed === 1
                  ? "Removed {removed}. {failed} item couldn’t be removed."
                  : "Removed {removed}. {failed} items couldn’t be removed.",
                { removed: outcome.removed, failed: outcome.failed },
              )
            : t("Removed"),
        ),
      )
      .catch(() => showToast(t("Couldn’t remove import")))
      .finally(() => {
        setBusy(undefined);
        void history.reload();
      });
  };

  return (
    <div className="desktop-page import-page">
      <SkillImport onError={onError} onSkills={() => goTo("skills")} />
      <Section>
        <Row label="Import conversations">
          <Button
            disabled={remoteBusy}
            onClick={() => {
              setRemoteBusy(true);
              void window.desktop
                .claudeAiImportSignIn()
                .then(() => window.desktop.claudeAiImportFetch())
                .then((sources) => {
                  if (sources.some((source) => !source || "problem" in source))
                    throw new Error(
                      t("Your conversation export didn’t import"),
                    );
                  setWizard(true);
                })
                .catch(onError)
                .finally(() => setRemoteBusy(false));
            }}
          >
            {remoteBusy ? "Continue in browser" : "Sign in"}
          </Button>
          {remoteBusy && (
            <Button onClick={() => void window.desktop.claudeAiImportCancel()}>
              Cancel
            </Button>
          )}
        </Row>
      </Section>
      {policy.localMcpEditing && (
        <Section>
          <Row
            label="Import local MCP servers"
            description="Review supported configurations on this computer. Selected servers are added disabled."
          >
            <Button onClick={() => setMcpImport(true)}>Review…</Button>
          </Row>
        </Section>
      )}
      {mcpImport && (
        <Suspense fallback={null}>
          <LocalMcpImportDialog onClose={() => setMcpImport(false)} />
        </Suspense>
      )}
      <Section>
        <Row label="Import Claudex Code sessions">
          <Button onClick={() => setCliImport(true)}>Import…</Button>
        </Row>
      </Section>
      {cliImport && (
        <Suspense fallback={null}>
          <CliImportDialog
            onClose={() => {
              setCliImport(false);
              void history.reload();
            }}
          />
        </Suspense>
      )}
      <Section>
        <Row
          label="Import"
          description="Bring over conversations and projects from a Claudex export or from a data folder copied from another computer. Each import is a one-time copy and won’t sync."
        >
          <Button primary onClick={() => setWizard(true)}>
            Import…
          </Button>
        </Row>
      </Section>
      {/* Local export lives in Import. */}
      <Section>
        <Row
          label="Export"
          description={formatText(
            "Save this {platform}’s chats, Cowork tasks, and Code sessions as a zip file.",
            { platform: platform === "darwin" ? "Mac" : "PC" },
          )}
        >
          <Button
            disabled={exporting}
            onClick={() => {
              setExporting(true);
              void window.desktop
                .exportData()
                .catch(onError)
                .finally(() => setExporting(false));
            }}
          >
            <Upload size={16} />
            Export…
          </Button>
        </Row>
      </Section>
      <section className="import-history">
        <h3>{t("Import history")}</h3>
        <div className="import-history-list">
          {runs.length === 0 ? (
            <p className="import-history-empty">
              {history.value ? t("No imports yet") : ""}
            </p>
          ) : (
            runs.map((run) => (
              <div className="import-history-row" key={run.runId}>
                <Download size={16} aria-hidden="true" />
                <div className="import-history-text">
                  <div>{t(runSourceName(run))}</div>
                  <small>{runCounts(run.counts)}</small>
                </div>
                <time dateTime={new Date(run.timestamp).toISOString()}>
                  {new Date(run.timestamp).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
                <Button
                  disabled={busy === run.runId || busy === "*"}
                  onClick={() => ask(run)}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </div>
        {runs.length > 0 && (
          <div className="import-history-all">
            <Button disabled={busy !== undefined} onClick={() => ask("*")}>
              Remove all
            </Button>
          </div>
        )}
      </section>
      {wizard && (
        <ImportDialog
          onError={onError}
          onClose={(imported) => {
            setWizard(false);
            if (imported) void history.reload();
          }}
        />
      )}
      {removing && (
        <RemoveImportDialog
          runs={runs}
          target={removing.target}
          preview={removing.preview}
          onConfirm={() => remove(removing.target)}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </div>
  );
}

/** "Remove this import?" (or all of them) with what would be deleted. */
export function RemoveImportDialog({
  runs,
  target,
  preview,
  onConfirm,
  onClose,
}: {
  runs: HistoryImportRun[];
  target: HistoryImportRun | "*";
  preview: HistoryRemovePreview | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const counts =
    preview ??
    (target === "*"
      ? runs.reduce(
          (sum, run) => ({
            conversations: sum.conversations + run.counts.conversations,
            projects: sum.projects + run.counts.projects,
            modifiedSinceImport: 0,
          }),
          { conversations: 0, projects: 0, modifiedSinceImport: 0 },
        )
      : { ...target.counts, modifiedSinceImport: 0 });
  return (
    <RemoveBody
      title={t(target === "*" ? "Remove all imports?" : "Remove this import?")}
      counts={counts}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function RemoveBody({
  title,
  counts,
  onConfirm,
  onClose,
}: {
  title: string;
  counts: HistoryRemovePreview;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <SettingsModal title={title} onClose={onClose} variant="confirm">
      <p className="confirm-body">
        {countText(
          counts.conversations,
          "{n} conversation",
          "{n} conversations",
        )}
        {counts.projects > 0 &&
          ` ${countText(counts.projects, "and {n} project", "and {n} projects")}`}{" "}
        {t("will be deleted. This can’t be undone.")}
        {counts.modifiedSinceImport > 0 && (
          <span className="import-remove-warning">
            {countText(
              counts.modifiedSinceImport,
              "{n} of these conversations has been used since import. Removing will delete that activity.",
              "{n} of these conversations have been used since import. Removing will delete that activity.",
            )}
          </span>
        )}
      </p>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="primary danger-button"
          onClick={onConfirm}
        >
          {t("Remove")}
        </button>
      </div>
    </SettingsModal>
  );
}
