import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleCheck } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { CloudContinuationPlan } from "../../shared/cloud-continue-api";
import type { Conversation } from "../../shared/types";
import { api } from "../desktop-api";
import { formatText, t } from "../i18n";
import { Modal } from "../ui/Controls";
import { armResume } from "./continue-resume";
import {
  askToPushPrompt,
  canAskToPush,
  offersPullAndPush,
  pullAndPushPrompt,
  continuationDescription,
  continuationSteps,
  planUnreadable,
  runContinuation,
  stepLabels,
  type ContinuationFailure,
  type ContinuationProgress,
  type ContinuationStep,
  type Description,
} from "./continue-in-cloud";
import "./continue-in-cloud.css";

type Phase =
  | { kind: "confirm" }
  | { kind: "moving"; step: ContinuationStep }
  | { kind: "failed"; failure: ContinuationFailure };

/** The description's paragraphs; names are code. */
function Paragraphs({ description }: { description: Description }) {
  return (
    <>
      {description.map((segments, index) => (
        <p key={index} className="confirm-body">
          {segments.map((segment, at) =>
            typeof segment === "string" ? (
              segment
            ) : (
              <code key={at} className="continue-cloud-code">
                <bdi>{segment.code}</bdi>
              </code>
            ),
          )}
        </p>
      ))}
    </>
  );
}

/**
 * "Move this session to the cloud?": the session's Continue in ▸ Cloud row
 * opens it over the session. It reads the folder's git state first and says
 * what comes along; Continue in cloud then runs the steps with a list under the
 * description ("Step {step} of {total}: {label}" for screen readers). A refused
 * upload shows what git said and offers Ask Claudex to push, which asks this
 * session to run the push and brings the dialog back when that turn ends
 * (`resume`). The new cloud session opens when it is ready; this session stays.
 */
export function ContinueInCloudDialog({
  conversation,
  onClose,
  onMoved,
  onAskedToPush,
  resume,
}: {
  conversation: Conversation;
  onClose: () => void;
  onMoved: (created: Conversation, unverified?: boolean) => void;
  /** This session was asked to push the work; the dialog closes. */
  onAskedToPush?: () => void;
  /** Back after the asked turn: continue as if the work were uploaded. */
  resume?: { includeUntracked: boolean };
}) {
  const [includeUntracked, setIncludeUntracked] = useState(
    resume?.includeUntracked ?? true,
  );
  const [plan, setPlan] = useState<CloudContinuationPlan>();
  const [planFailed, setPlanFailed] = useState(false);
  const [reading, setReading] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  // Saving was refused (the folder changed): said above the plan read again.
  const [alert, setAlert] = useState<string>();
  const progress = useRef<ContinuationProgress>({});
  const live = useRef(true);
  const resumed = useRef(false);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    let current = true;
    setPlan(undefined);
    setPlanFailed(false);
    api.cloudContinuationPlan(conversation.id, { includeUntracked }).then(
      (next) => current && setPlan(next),
      () => current && setPlanFailed(true),
    );
    return () => {
      current = false;
    };
  }, [conversation.id, reading, includeUntracked]);

  const ready = plan?.kind === "ready" ? plan : undefined;
  const moving = phase.kind === "moving";
  const run = async (alreadyUploaded = false) => {
    setAlert(undefined);
    const result = await runContinuation({
      api,
      conversation,
      includeUntracked,
      alreadyUploaded,
      progress: progress.current,
      onStep: (step) => live.current && setPhase({ kind: "moving", step }),
    });
    if (!live.current) return;
    if ("created" in result) {
      onMoved(result.created, result.unverified);
      return;
    }
    if (result.failed.step === "saving_work") {
      // Back to what comes along, read again.
      setAlert(result.failed.message);
      setPhase({ kind: "confirm" });
      setReading((n) => n + 1);
      return;
    }
    setPhase({ kind: "failed", failure: result.failed });
  };
  // Back after Ask Claudex to push: it goes on once the plan is read.
  useEffect(() => {
    if (!resume || resumed.current || !ready) return;
    resumed.current = true;
    void run(true);
    // run reads the latest state through refs; only the plan starts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, ready]);

  const askToPush = async (command: string) => ask(askToPushPrompt(command));
  // Asks this session to do the git step, then brings the dialog back.
  const ask = async (text: string) => {
    try {
      const sent = await api.send({
        conversationId: conversation.id,
        text,
        mode: "code",
        attachments: [],
        providerId: conversation.providerId,
        model: conversation.model,
      });
      armResume(conversation.id, {
        includeUntracked,
        turns: sent.turns.length,
      });
      onAskedToPush?.();
    } catch (error) {
      setPhase({
        kind: "failed",
        failure: {
          step: "creating_session",
          message:
            error instanceof Error && error.message
              ? error.message
              : planUnreadable,
        },
      });
    }
  };

  // The confirming button: what it says depends on where things stand.
  const action: { label: string; onClick: () => void } =
    phase.kind === "failed" && offersPullAndPush(phase.failure)
      ? { label: "Pull and push", onClick: () => void ask(pullAndPushPrompt) }
      : phase.kind === "failed"
        ? { label: "Try again", onClick: () => void run() }
        : planFailed
          ? { label: "Check again", onClick: () => setReading((n) => n + 1) }
          : plan?.kind === "blocked"
            ? plan.blocker === "too_many_untracked" && includeUntracked
              ? {
                  label: "Continue without untracked files",
                  onClick: () => setIncludeUntracked(false),
                }
              : {
                  label: "Check again",
                  onClick: () => setReading((n) => n + 1),
                }
            : plan?.kind === "unsupported"
              ? { label: "Got it", onClick: onClose }
              : { label: "Continue in cloud", onClick: () => void run() };
  const disabled = moving || (!plan && !planFailed);
  const description: Description =
    phase.kind === "failed"
      ? [[phase.failure.message]]
      : planFailed
        ? [[formatText(planUnreadable)]]
        : continuationDescription(plan);
  const current = moving ? continuationSteps.indexOf(phase.step) : -1;
  const failure = phase.kind === "failed" ? phase.failure : undefined;
  return createPortal(
    <Modal
      title="Move this session to the cloud?"
      onClose={() => !moving && onClose()}
      variant="confirm"
      confirmFocus="cancel"
      className="continue-cloud"
    >
      {!moving && <Paragraphs description={description} />}
      {failure && (
        <span className="sr-only" role="status">
          {failure.message}
        </span>
      )}
      {moving && (
        <div className="continue-cloud-steps">
          <span className="sr-only" aria-live="polite">
            {formatText("Step {step} of {total}: {label}", {
              step: current + 1,
              total: continuationSteps.length,
              label: t(stepLabels[phase.step]),
            })}
          </span>
          <ul aria-hidden="true">
            {continuationSteps.map((step, index) => {
              const state =
                index < current
                  ? "done"
                  : index === current
                    ? "running"
                    : "pending";
              return (
                <li key={step} data-state={state}>
                  <span className="continue-cloud-step-icon">
                    {state === "done" ? (
                      <CircleCheck size={14} strokeWidth={1.5} />
                    ) : state === "running" ? (
                      <Spinner inheritColor size={14} className="spin" />
                    ) : (
                      <span className="continue-cloud-step-dot" />
                    )}
                  </span>
                  <span>{stepLabels[step]}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {failure?.step === "uploading" &&
        (failure.excerpt || canAskToPush(failure)) && (
          <div className="continue-cloud-git">
            {failure.excerpt && (
              <div className="continue-cloud-said">
                <span>Git said:</span>
                <pre dir="ltr">{failure.excerpt}</pre>
              </div>
            )}
            {canAskToPush(failure) && !offersPullAndPush(failure) && (
              <div>
                <button
                  className="secondary continue-cloud-ask"
                  onClick={() => void askToPush(failure.command!)}
                >
                  Ask Claudex to push
                </button>
              </div>
            )}
          </div>
        )}
      {phase.kind === "confirm" && alert && plan?.kind !== "blocked" && (
        <p role="alert" className="continue-cloud-alert">
          {alert}
        </p>
      )}
      <div className="button-row">
        <button className="secondary" disabled={moving} onClick={onClose}>
          Cancel
        </button>
        <button
          className={`primary ${moving ? "busy" : ""}`}
          disabled={disabled}
          aria-busy={moving || undefined}
          onClick={action.onClick}
        >
          <span className="busy-label">{action.label}</span>
          {moving && <Spinner inheritColor size="sm" className="spin" />}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
