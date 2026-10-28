import { useContext, useEffect, useId, useState } from "react";
import { Lightbulb, X } from "../ui/glyphs";
import type { Conversation, Turn } from "../../shared/types";
import {
  dismissNextStep,
  emptyPacing,
  nextStepInput,
  nextStepSuppressed,
  suggestionItem,
  type NextStepPacing,
  type NextStepBackoff,
  emptyTipPacing,
  tipAllowed,
  type ArtifactTipPacing,
} from "../../shared/chat-suggestions";
import {
  capabilityTipKey,
  capabilityTipResult,
} from "../../shared/capability-tips";
import { AppContext } from "../app/AppContext";
import { sendText } from "../app/composer-send";
import { formatText, t, useLocale } from "../i18n";
import { nextStepCopy } from "./next-step-copy";
import "./chat-suggestions.css";
import { actOnCapabilityTip } from "./tip-actions";
import { useTipAvailability } from "./useTipAvailability";
import { capabilityTipCopy } from "./capability-tip-copy";

function read<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fallback;
    const result = { ...fallback, ...value };
    for (const [name, sample] of Object.entries(fallback as object)) {
      const stored = value[name];
      const valid = Array.isArray(sample)
        ? Array.isArray(stored)
        : typeof sample === "number"
          ? typeof stored === "number" && Number.isFinite(stored)
          : typeof sample === "object"
            ? stored && typeof stored === "object" && !Array.isArray(stored)
            : typeof stored === typeof sample;
      if (!valid) result[name] = sample;
    }
    return result;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function ChatSuggestions({
  conversation,
  turn,
  kind = "next-step",
}: {
  conversation: Conversation;
  turn: Turn;
  kind?: "next-step" | "tip";
}) {
  const app = useContext(AppContext);
  const availableTips = useTipAvailability(conversation);
  useLocale();
  const label = useId();
  const item = turn.items.find(
    (item) =>
      suggestionItem(item) &&
      item.tool ===
        (kind === "tip" ? "suggest_capability" : "offer_next_step_v0"),
  );
  const input = item ? nextStepInput(item.arguments) : undefined;
  const tip =
    kind === "tip"
      ? (capabilityTipResult(item)?.feature ??
        capabilityTipKey(turn.capabilityTip?.feature))
      : undefined;
  const scope = app?.accountId ?? "local";
  const key = `claudex:offer-next-step-pacing:${scope}:${conversation.id}`;
  const backoffKey = `claudex:offer-next-step-backoff:${scope}`;
  const outcomeKey = `claudex:offer-next-step:${scope}:${conversation.id}:${item?.id ?? tip ?? "tip"}`;
  const [closedKey, setClosedKey] = useState<string>();
  const hidden =
    closedKey === outcomeKey || read(outcomeKey, { hidden: false }).hidden;
  const [busy, setBusy] = useState(false);
  const pacing = read<NextStepPacing>(key, emptyPacing());
  const backoff = read<NextStepBackoff>(backoffKey, {
    closes: [],
    pausedUntil: 0,
  });
  const tipKey = `claudex:capability-tip:${scope}`;
  const tipPacing = read<ArtifactTipPacing>(tipKey, emptyTipPacing());
  const savedTips = app?.snapshot?.settings.capabilityTipState;
  const currentTipPacing = savedTips ?? tipPacing;
  const saveTipPacing = (state: ArtifactTipPacing) => {
    write(tipKey, state);
    void app?.updatePreference?.({ capabilityTipState: state }).catch(() => {});
  };
  const shownIndex = conversation.turns.findIndex(
    (value) => value.id === pacing.shownFor,
  );
  const turnsSince =
    shownIndex < 0 ? undefined : conversation.turns.indexOf(turn) - shownIndex;
  const latest = conversation.turns.at(-1)?.id === turn.id;
  const textFollows =
    !!item &&
    turn.items
      .slice(item ? turn.items.indexOf(item) + 1 : 0)
      .some((value) => value.type === "agentMessage" && value.text?.trim());
  const eligible =
    !!app &&
    (!!item || !!tip) &&
    (!item || (item.success !== false && item.status !== "failed")) &&
    !conversation.incognito &&
    (kind !== "tip" ||
      !turn.items.some(
        (value) =>
          value.tool === "offer_next_step_v0" &&
          value.success !== false &&
          nextStepInput(value.arguments),
      )) &&
    latest &&
    turn.status === "completed" &&
    !hidden &&
    !textFollows &&
    (input
      ? backoff.pausedUntil <= Date.now() &&
        !nextStepSuppressed(pacing, item!.id, input.offer, turnsSince)
      : !!tip &&
        availableTips.includes(tip) &&
        tipAllowed(currentTipPacing, tip, conversation.id));
  useEffect(() => {
    if (
      kind !== "tip" ||
      turn.status !== "inProgress" ||
      conversation.incognito
    )
      return;
    const state =
      savedTips ?? read<ArtifactTipPacing>(tipKey, emptyTipPacing());
    if (
      state.lastShownConversation &&
      state.lastCountedConversation !== conversation.id
    ) {
      saveTipPacing({
        ...state,
        lastCountedConversation: conversation.id,
        sessionsSinceLastShow: state.sessionsSinceLastShow + 1,
      });
    }
  }, [kind, tipKey, conversation.id, conversation.incognito, turn.status]);
  useEffect(() => {
    if (eligible && tip) {
      const state =
        savedTips ?? read<ArtifactTipPacing>(tipKey, emptyTipPacing());
      if (state.ledger[tip]?.lastSessionId !== conversation.id)
        saveTipPacing({
          ...state,
          lastShownConversation: conversation.id,
          lastCountedConversation: conversation.id,
          sessionsSinceLastShow: 0,
          ledger: {
            ...state.ledger,
            [tip]: {
              count: (state.ledger[tip]?.count ?? 0) + 1,
              lastSessionId: conversation.id,
            },
          },
        });
      return;
    }
    if (
      !eligible ||
      (!item && !tip) ||
      (item && pacing.shownToolUseId === item.id)
    )
      return;
    write(key, {
      ...pacing,
      shownFor: turn.id,
      shownToolUseId: item?.id,
      outcome: "ignored",
      open: input ? { ...pacing.open, [input.offer]: item!.id } : pacing.open,
    });
  }, [eligible, item?.id, key, turn.id, tip, tipKey, conversation.id]);
  if (!eligible || !app || (!item && !tip)) return null;
  const copy = input ? nextStepCopy[input.offer] : undefined;
  const prompt = input
    ? copy!.prompts[input.scenario]
    : tip === "artifacts"
      ? "Make this an artifact I can keep editing and share."
      : tip === "document_creation"
        ? "Turn this into a file I can download and send as is."
        : undefined;
  const caption =
    copy?.caption ?? (tip ? capabilityTipCopy[tip].body : undefined);
  function close(outcome: "clicked" | "dismissed") {
    if (tip && outcome === "dismissed") {
      const state =
        savedTips ?? read<ArtifactTipPacing>(tipKey, emptyTipPacing());
      saveTipPacing({
        ...state,
        dismissed: [...new Set([...state.dismissed, tip])],
      });
    }
    const current = read<NextStepPacing>(key, emptyPacing());
    const open = { ...current.open };
    if (input && outcome === "clicked") delete open[input.offer];
    if (input)
      write(key, {
        ...current,
        open,
        outcome,
        closed: current.closed || outcome === "dismissed",
      });
    write(outcomeKey, { hidden: true });
    if (input && outcome === "dismissed")
      write(backoffKey, dismissNextStep(backoff, Date.now()));
    setClosedKey(outcomeKey);
  }
  if (tip)
    return (
      <div
        className="artifact-capability-tip"
        data-cds="Banner"
        data-testid="artifact-tip"
      >
        <Lightbulb
          size={16}
          className="artifact-capability-tip-icon"
          aria-hidden="true"
        />
        <div className="artifact-capability-tip-body">
          <span>{t(caption!)}</span>
          {tip !== "file_uploads" && tip !== "screenshots" && (
            <button
              className="chat-next-step-chip"
              onClick={() => {
                actOnCapabilityTip(app, tip);
                close("clicked");
              }}
            >
              {t(capabilityTipCopy[tip].action!)}
            </button>
          )}
        </div>
        <button
          className="chat-next-step-dismiss"
          aria-label={t("Dismiss")}
          onClick={() => close("dismissed")}
        >
          <X size={16} />
        </button>
      </div>
    );
  return (
    <div
      className="chat-next-step"
      role="group"
      aria-labelledby={label}
      data-testid={input ? "offer-next-step" : "artifact-tip"}
    >
      <span id={label} className="chat-next-step-caption">
        {t(caption!)}
      </span>
      <span className="sr-only" aria-live="polite">
        {formatText("Suggested next step: {caption}", { caption: t(caption!) })}
      </span>
      <div className="chat-next-step-chips">
        <button
          className="chat-next-step-chip"
          disabled={busy}
          onClick={async () => {
            if (input && app.text.trim()) return;
            setBusy(true);
            try {
              if (input) await sendText(app, t(prompt!));
              else {
                app.setText((text) =>
                  text ? `${text}\n\n${t(prompt!)}` : t(prompt!),
                );
                app.composer.current?.focus();
              }
              close("clicked");
            } catch (error) {
              app.report(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t(copy?.chip ?? "Add to message")}
        </button>
        <button
          className="chat-next-step-dismiss"
          disabled={busy}
          aria-label={t(input ? "Dismiss suggestion" : "Dismiss tip")}
          onClick={() => close("dismissed")}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
