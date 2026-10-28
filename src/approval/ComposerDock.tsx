import { Suspense, useRef, useState, type CSSProperties } from "react";
import type { Approval, Conversation, Settings } from "../../shared/types";
import { ApprovalCard } from "../ui/ApprovalCard";
import { planAcceptTargets, planAwaitingApproval } from "../plan/plan-approval";
import { ComputerUseDockItems } from "../computer-use/ComputerUseDockItems";
import { useApprovalFocusHandoff } from "./focus-handoff";
import { lazyPiece } from "../ui/lazy-piece";

const PlanApprovalCard = lazyPiece(
  () => import("../plan/PlanApprovalCard"),
  "PlanApprovalCard",
);

/** Ghost cards drawn behind the frontmost request, at most. */
const MAX_GHOSTS = 2;

/**
 * Cards docked above the open conversation's composer: pending Codex requests
 * first, then computer use's access requests and its activity line (R10), else
 * the approve card for a finished plan.
 *
 * Only the first request is a card; up to two more peek out above it as ghosts,
 * each 6px higher, 3% narrower and 25% fainter than the one before. Answering
 * the first promotes the next from the first ghost's place (220ms
 * ease-out-cubic) while the ghosts behind it step forward. Requests already
 * waiting when a conversation opens are shown in place, without the promotion.
 * Answering the front card from the keyboard hands focus to the next card, or
 * back to the composer (focus-handoff.ts).
 */
export function ComposerDock({
  conversation,
  approvals,
  settings,
  platform,
  updatePreference,
  onSent,
  onFocusComposer,
  onError,
  canSend,
}: {
  conversation: Conversation;
  approvals: Approval[];
  settings: Settings;
  platform: string;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  canSend?: () => boolean;
  onSent: (conversation: Conversation) => void;
  onFocusComposer: () => void;
  onError: (error: unknown) => void;
}) {
  // Finished plans the user chose to keep refining get no approve card.
  const [keptPlanning, setKeptPlanning] = useState(new Set<string>());
  const pending = approvals.filter(
    (approval) => approval.conversationId === conversation.id,
  );
  const planTurn = pending.length
    ? undefined
    : planAwaitingApproval(conversation, settings);
  const mac = platform === "darwin";
  // The requests that were already waiting when this conversation opened.
  const opened = useRef<{ conversationId: string; waiting: Set<unknown> }>(
    undefined,
  );
  if (opened.current?.conversationId !== conversation.id)
    opened.current = {
      conversationId: conversation.id,
      waiting: new Set(pending.map((approval) => approval.id)),
    };
  const [front, ...behind] = pending;
  const stackRef = useRef<HTMLDivElement>(null);
  const handoff = useApprovalFocusHandoff({
    stackRef,
    conversationId: conversation.id,
    frontId: front?.id,
    pendingIds: pending.map((approval) => approval.id),
    onFocusComposer,
  });
  return (
    <>
      {front && (
        <div
          ref={stackRef}
          {...handoff}
          className="approval-stack"
          data-skip-enter={opened.current.waiting.has(front.id) || undefined}
        >
          {behind.slice(0, MAX_GHOSTS).map((approval, index) => (
            <div
              key={approval.id}
              className="approval-ghost"
              style={{ "--ghost-depth": index + 1 } as CSSProperties}
              aria-hidden="true"
            />
          ))}
          <ApprovalCard
            key={front.id}
            approval={front}
            conversation={conversation}
            frontmost
            mac={mac}
            onError={onError}
          />
        </div>
      )}
      <ComputerUseDockItems
        conversationId={conversation.id}
        mac={mac}
        frontmost={!pending.length}
        onError={onError}
      />
      {planTurn && !keptPlanning.has(planTurn.id) && (
        <Suspense fallback={null}>
          <PlanApprovalCard
            key={planTurn.id}
            conversation={conversation}
            mac={mac}
            autoAcceptAvailable
            moreTargets={planAcceptTargets(settings, conversation.cwd)}
            updatePreference={updatePreference}
            canSend={canSend}
            onSent={onSent}
            onKeepPlanning={() => {
              setKeptPlanning((ids) => new Set(ids).add(planTurn.id));
              onFocusComposer();
            }}
            onError={onError}
          />
        </Suspense>
      )}
    </>
  );
}
