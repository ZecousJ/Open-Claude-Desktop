import { Suspense, useEffect, useRef, useState } from "react";
import { ChevronDown } from "../ui/glyphs";
import type { Conversation, Settings } from "../../shared/types";
import {
  ActionButton,
  useApprovalShortcuts,
} from "../approval/ApprovalActions";
import { Menu, type MenuPosition } from "../ui/Menu";
import { t } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { planRevisionText } from "../../shared/plan-comments";
import {
  planCommentKey,
  planComments,
  usePlanComments,
} from "./plan-comments-store";
import type { PlanTarget } from "./plan-approval";
export {
  planAcceptTargets,
  planAwaitingApproval,
  type PlanTarget,
} from "./plan-approval";

const PlanCommentList = lazyPiece(
  () => import("./PlanComments"),
  "PlanCommentList",
);

/**
 * The card under a finished plan, as the original's ExitPlanMode card:
 * "proposed a plan" with an Open plan link; Reject and Revise… (Esc) on the
 * left; on the right Accept (⇧⌘↩) and "Accept and allow edits" (⌘↩). Revise…
 * unfolds a feedback field with Back and Revise. Accepting leaves Plan mode and
 * starts the work; rejecting keeps planning; a revision goes back as the next
 * message, still in Plan mode. The accept button carries More accept options:
 * Accept and auto mode, and Accept and bypass permissions where the folder
 * allows it.
 */
export function PlanApprovalCard({
  conversation,
  mac,
  autoAcceptAvailable,
  moreTargets = [],
  updatePreference,
  onSent,
  onKeepPlanning,
  onError,
  canSend,
}: {
  conversation: Conversation;
  mac: boolean;
  /** Accepting edits automatically is unavailable on Windows. */
  autoAcceptAvailable: boolean;
  /** More accept options' targets (planAcceptTargets). */
  moreTargets?: PlanTarget[];
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  onSent: (conversation: Conversation) => void;
  onKeepPlanning: () => void;
  onError: (error: unknown) => void;
  canSend?: () => boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const planId = planCommentKey(
    conversation.id,
    [...(conversation.turns.at(-1)?.items ?? [])]
      .reverse()
      .find((item) => item.type === "plan")?.id ?? "",
  );
  const comments = usePlanComments(planId);
  const hasComments = comments.length > 0;
  const showFeedback = revising || hasComments;
  useEffect(() => {
    planComments.enable(planId, !busy);
    return () => planComments.enable(planId, false);
  }, [planId, busy]);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (revising) field.current?.focus();
  }, [revising]);
  async function send(
    text: string,
    leavePlan?: { autoAccept: boolean; target?: PlanTarget },
  ) {
    if (busy) return;
    setBusy(true);
    try {
      if (leavePlan)
        await updatePreference({
          codePlanMode: false,
          autoAcceptEdits: leavePlan.target ? false : leavePlan.autoAccept,
          codeSandbox:
            leavePlan.target === "bypass"
              ? "danger-full-access"
              : "workspace-write",
        });
      if (canSend && !canSend()) return;
      const sent = await window.desktop.send({
        conversationId: conversation.id,
        text,
        mode: conversation.mode,
        cwd: conversation.cwd,
        projectId: conversation.projectId,
        providerId: conversation.providerId,
        model: conversation.model,
        attachments: [],
      });
      if (canSend && !canSend()) return;
      onSent(sent);
      planComments.clear(planId);
    } catch (error) {
      if (!(error instanceof Error && error.name === "CodePermissionCanceled"))
        onError(error);
      setBusy(false);
    }
  }
  const accept = (autoAccept: boolean, target?: PlanTarget) =>
    void send("Implement the plan.", { autoAccept, target });
  const moreButton = useRef<HTMLButtonElement>(null);
  const [moreMenu, setMoreMenu] = useState<MenuPosition>();
  const back = () => {
    setRevising(false);
    setFeedback("");
  };
  /** Without a note there is nothing to send: the plan stays as it is. */
  const revise = () => {
    const note = planRevisionText(comments, feedback);
    if (note) void send(note);
    else onKeepPlanning();
  };
  const handlers = {
    deny: () => setRevising(true),
    always: autoAcceptAvailable ? () => accept(false) : undefined,
    once: () => accept(autoAcceptAvailable),
    digits: false,
  };
  // Esc and ⌘↩ belong to the feedback field while it is open.
  useApprovalShortcuts(!busy && !showFeedback, handlers, mac);
  return (
    <section
      className="approval-card"
      data-kind="plan"
      aria-label="Claudex proposed a plan"
      aria-busy={busy || undefined}
    >
      <header className="plan-card-header">
        <h3 className="approval-title">Claudex proposed a plan</h3>
        <button type="button" className="plan-card-open" onClick={openPlan}>
          Open plan
        </button>
      </header>
      {hasComments && (
        <Suspense fallback={null}>
          <PlanCommentList planId={planId} disabled={busy} />
        </Suspense>
      )}
      {showFeedback && (
        <textarea
          ref={field}
          className="approval-feedback"
          aria-label="Plan feedback"
          placeholder={t(
            hasComments
              ? "Anything else to add?"
              : "What should change? (optional)",
          )}
          rows={3}
          value={feedback}
          disabled={busy}
          maxLength={20000}
          onChange={(event) => setFeedback(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              if (!hasComments) back();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              revise();
            }
          }}
        />
      )}
      <div className="approval-actions">
        {showFeedback ? (
          <>
            {!hasComments && (
              <ActionButton
                label="Back"
                keys={[]}
                disabled={busy}
                mac={mac}
                onClick={back}
              />
            )}
            <span className="approval-actions-gap" />
            <ActionButton
              label="Revise"
              keys={[]}
              primary
              disabled={busy}
              mac={mac}
              onClick={revise}
            />
          </>
        ) : (
          <>
            <ActionButton
              label="Reject"
              keys={[]}
              disabled={busy}
              mac={mac}
              onClick={onKeepPlanning}
            />
            <ActionButton
              label="Revise…"
              keys={[["esc"]]}
              disabled={busy}
              mac={mac}
              onClick={() => setRevising(true)}
            />
            <span className="approval-actions-gap" />
            {autoAcceptAvailable && (
              <ActionButton
                label="Accept"
                keys={[["shift", "mod", "enter"]]}
                disabled={busy}
                mac={mac}
                onClick={() => accept(false)}
              />
            )}
            <ActionButton
              label={autoAcceptAvailable ? "Accept and allow edits" : "Accept"}
              keys={[["mod", "enter"]]}
              primary
              disabled={busy}
              mac={mac}
              onClick={() => accept(autoAcceptAvailable)}
            />
            {moreTargets.length > 0 && (
              <button
                ref={moreButton}
                type="button"
                className="approval-button approval-once-more"
                data-primary
                aria-label={t("More accept options")}
                aria-haspopup="menu"
                aria-expanded={Boolean(moreMenu)}
                disabled={busy}
                onClick={() => {
                  if (moreMenu) return setMoreMenu(undefined);
                  const box = moreButton.current!.getBoundingClientRect();
                  setMoreMenu({
                    right: window.innerWidth - box.right,
                    bottom: window.innerHeight - box.top + 4,
                  });
                }}
              >
                <ChevronDown size={13} strokeWidth={1.75} />
              </button>
            )}
            {moreMenu && (
              <Menu
                label="More accept options"
                entries={moreTargets.map((target) => ({
                  label:
                    target === "auto"
                      ? "Accept and auto mode"
                      : "Accept and bypass permissions",
                  onSelect: () => accept(false, target),
                }))}
                position={moreMenu}
                width={240}
                anchors={[moreButton]}
                onClose={() => setMoreMenu(undefined)}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Open plan: the plan is the turn's last text in the transcript (the Plan
 * panel lists task steps, not this text), so the link brings it into view.
 */
function openPlan() {
  const plans = document.querySelectorAll(".plan-message");
  plans.item(plans.length - 1)?.scrollIntoView({ block: "start" });
}
