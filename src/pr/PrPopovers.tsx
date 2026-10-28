import { useId, useRef, useState, type ReactNode } from "react";
import { ExternalLink, ChevronDown } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type {
  GitHubPullRequest,
  PullRequestCheckCounts,
} from "../../shared/github-api";
import { ciChipLabel, type CiStatus } from "../../shared/pull-request-status";
import { useDismiss } from "../ui/useDismiss";
import { ReasonTooltip, WithTooltip } from "../ui/Tooltip";
import { CheckGlyph, PrStateGlyph } from "./PrStateGlyph";

/**
 * A popover of the branch row: it opens above its button, and a press outside
 * or Escape closes it.
 */
function useBarPopover() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismiss([box], open, () => setOpen(false));
  return { open, setOpen, box };
}

/** The CI dot: 6px green or red, a spinner while running. */
export function CiDot({ status }: { status: CiStatus }) {
  if (status === "pending")
    return (
      <Spinner
        inheritColor
        size={12}
        className="spin pr-ci-spin"
        aria-hidden="true"
      />
    );
  // Skipped and unavailable: no dot.
  if (status === "skipped" || status === "unavailable") return null;
  return <i className="pr-dot" data-checks={status} aria-hidden="true" />;
}

/** One row of the counts: icon, state, count; none at 0. */
function CountRow({
  icon,
  label,
  count,
}: {
  icon: ReactNode;
  label: string;
  count: number;
}) {
  if (!count) return null;
  return (
    <div className="pr-ci-count">
      <span className="pr-ci-count-label">
        <span className="pr-ci-count-icon">{icon}</span>
        {label}
      </span>
      <span className="pr-ci-count-number">{count}</span>
    </div>
  );
}

/** The 6px ring of a check that never ran. */
const ring = (
  <span className="pr-ci-ring" aria-hidden="true">
    <i />
  </span>
);

function Counts({ counts }: { counts: PullRequestCheckCounts | undefined }) {
  if (!counts) return <div className="pr-ci-note">CI checks unavailable.</div>;
  if (!counts.failed && !counts.pending && !counts.passed && !counts.skipped)
    return <div className="pr-ci-note">No checks reported yet.</div>;
  return (
    <div className="pr-ci-counts">
      <CountRow
        icon={<CheckGlyph result="failed" />}
        label="Failed"
        count={counts.failed}
      />
      <CountRow
        icon={
          <Spinner
            inheritColor
            size={12}
            className="spin pr-ci-spin"
            aria-hidden
          />
        }
        label="In progress"
        count={counts.pending}
      />
      <CountRow
        icon={<CheckGlyph result="passed" />}
        label="Passed"
        count={counts.passed}
      />
      <CountRow icon={ring} label="Skipped" count={counts.skipped} />
    </div>
  );
}

/**
 * A switch row of the panel: the xs switch, the label, and under it a hint, or
 * why it can't be changed.
 */
function SwitchRow({
  label,
  checked,
  disabled,
  reason,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  reason?: string;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const note = disabled ? reason : hint;
  return (
    <div className="pr-ci-switch-row">
      <label className="pr-ci-switch-label">
        <button
          type="button"
          role="switch"
          className="pr-switch"
          aria-checked={checked}
          aria-describedby={note ? id : undefined}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span />
        </button>
        <span>{label}</span>
      </label>
      {note && (
        <span id={id} className="pr-ci-switch-note">
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * The CI chip and its "CI monitoring" panel: the dot, "CI" and a caret; the
 * panel counts the head commit's checks by state, opens GitHub's checks page,
 * and holds the request's switches: Auto-fix CI and Address comments (a local
 * session is woken when checks fail or review comments arrive,
 * electron/pr-autofix.ts), Auto-merge when ready (GitHub merges once the
 * required checks and reviews pass) and Auto-archive on merge or close for this
 * session.
 */
export function CiChip({
  pr,
  status,
  autoMergeReason,
  autoMergeBusy,
  onAutoMerge,
  autoArchive,
  onAutoArchive,
  onOpenChecks,
  autoFix,
  onAutoFix,
}: {
  pr: GitHubPullRequest;
  status: CiStatus;
  /** Auto-fix CI and Address comments (local sessions; absent elsewhere). */
  autoFix?: { ci: boolean; comments: boolean };
  onAutoFix?: (next: { ci: boolean; comments: boolean }) => void;
  /** Why auto-merge can't be changed here; absent when it can. */
  autoMergeReason?: string;
  autoMergeBusy: boolean;
  onAutoMerge: (on: boolean) => void;
  autoArchive: boolean;
  onAutoArchive: (on: boolean) => void;
  onOpenChecks: () => void;
}) {
  const { open, setOpen, box } = useBarPopover();
  const label = ciChipLabel(status, pr.checkCounts);
  return (
    <span className="pr-popover-anchor" ref={box}>
      <WithTooltip label={label} disabled={open}>
        {(props) => (
          <button
            {...props}
            type="button"
            className="pr-ci"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <CiDot status={status} />
            CI
            <ChevronDown
              className="pr-ci-caret"
              size={12}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </button>
        )}
      </WithTooltip>
      {open && (
        <div
          className="pr-popover pr-ci-panel"
          role="dialog"
          aria-label="CI monitoring"
        >
          <div className="pr-ci-head">
            <span>CI monitoring</span>
            <WithTooltip label="Open checks on GitHub">
              {(props) => (
                <button
                  {...props}
                  type="button"
                  className="pr-ci-open"
                  aria-label="Open checks on GitHub"
                  onClick={onOpenChecks}
                >
                  <ExternalLink size={14} strokeWidth={1.75} />
                </button>
              )}
            </WithTooltip>
          </div>
          <Counts counts={pr.checkCounts} />
          <div className="pr-ci-rule" aria-hidden="true" />
          {autoFix && onAutoFix && (
            <>
              <SwitchRow
                label="Auto-fix CI"
                checked={autoFix.ci}
                onChange={(ci) =>
                  onAutoFix({ ci, comments: ci && autoFix.comments })
                }
              />
              <SwitchRow
                label="Address comments"
                checked={autoFix.ci && autoFix.comments}
                disabled={!autoFix.ci}
                reason="Turn on Auto-fix CI first to watch this PR"
                onChange={(comments) => onAutoFix({ ci: autoFix.ci, comments })}
              />
            </>
          )}
          <SwitchRow
            label="Auto-merge when ready"
            checked={Boolean(pr.autoMerge)}
            disabled={autoMergeBusy || autoMergeReason !== undefined}
            reason={autoMergeReason}
            onChange={onAutoMerge}
          />
          <SwitchRow
            label="Auto-archive on merge or close"
            checked={autoArchive}
            hint="Archive this session when its pull request is merged or closed. This session only; other sessions follow the default in Settings → Claudex Code."
            onChange={onAutoArchive}
          />
        </div>
      )}
    </span>
  );
}

/**
 * The conflict glyph's popover: the glyph is a button; its panel says the
 * request conflicts with its base branch and asks Claude to merge the base in,
 * resolve and push.
 */
export function ConflictFix({
  label,
  busyReason,
  onFix,
}: {
  label: string;
  /** Why Claude can't be asked now (it is working). */
  busyReason?: string;
  onFix: () => void;
}) {
  const { open, setOpen, box } = useBarPopover();
  return (
    <span className="pr-popover-anchor" ref={box}>
      <WithTooltip label={label} disabled={open}>
        {(props) => (
          <button
            {...props}
            type="button"
            className="pr-glyph pr-conflict"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <PrStateGlyph state="conflicting" />
          </button>
        )}
      </WithTooltip>
      {open && (
        <div
          className="pr-popover pr-conflict-panel"
          role="dialog"
          aria-label={label}
        >
          <div className="pr-conflict-text">
            <strong>{label}</strong>
            <span>This pull request has conflicts with its base branch.</span>
          </div>
          <div className="pr-conflict-actions">
            <ReasonTooltip reason={busyReason} placement="above">
              {(tip) => (
                <button
                  {...tip}
                  type="button"
                  className="pr-secondary"
                  aria-disabled={busyReason ? true : undefined}
                  onClick={() => {
                    if (busyReason) return;
                    setOpen(false);
                    onFix();
                  }}
                >
                  Ask Claudex to fix
                </button>
              )}
            </ReasonTooltip>
          </div>
        </div>
      )}
    </span>
  );
}
