import { useEffect, useRef, useState } from "react";
import type { Conversation, Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { api } from "../desktop-api";
import { useHost } from "../host/HostContext";
import { formatText, useLocale, useT } from "../i18n";
import { NoticeView } from "../policy/NoticeView";
import type {
  ComposerNoticeVariant,
  NoticeContent,
} from "../policy/notice-content";
import {
  canContinueInCloud,
  requestContinueInCloud,
} from "../app/continue-resume";
import {
  continuePrompt,
  lastSleep,
  onSleep,
  recordSleep,
  resumeWindowMs,
  settleSleep,
  sleepResume,
  turnProgress,
  type Resume,
  sleepTitle,
  awakeDuration,
} from "./sleep-band";

const resumeText: Record<Resume, string> = {
  expected: "Claudex will pick up where it left off.",
  resumed: "Claudex picked up where it left off.",
  needed: "Claudex couldn’t pick up where it left off.",
};

/**
 * The sleep band above a Code session's composer: "Your computer went to sleep
 * while Claude was working." with whether the session picked up, and up to two
 * buttons in this order: Keep computer awake (when the computer may still sleep
 * while coding; then Staying awake), Continue (only when it couldn't pick up;
 * Continue here beside the cloud), Continue in cloud (a local session that can
 * move there). Dismissible. It wears the frame of the notices above the
 * composer (NoticeView).
 */
export function SleepBand({
  conversation,
  variant,
  settings,
  updatePreference,
  onError,
  keepAwakeRework = true,
}: {
  conversation: Conversation | undefined;
  variant: ComposerNoticeVariant;
  settings: Settings;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  onError: (error: unknown) => void;
  keepAwakeRework?: boolean;
}) {
  const host = useHost();
  const t = useT();
  const locale = useLocale();
  const [slept, setSlept] = useState(lastSleep);
  const [continuing, setContinuing] = useState(false);
  const [keptAwake, setKeptAwake] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [, setSettled] = useState(0);
  const [dismissedAwake, setDismissedAwake] = useState<string>();
  const before = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      api?.onEvent?.((event) => {
        if (event.type === "slept")
          recordSleep({ suspendedAt: event.suspendedAt, wakeAt: event.wakeAt });
      }),
    [],
  );
  useEffect(() => onSleep(() => setSlept(lastSleep())), []);
  const id = conversation?.id;
  // What the turn showed when the window learned of the sleep; a running
  // turn has until `resumeWindowMs` after waking to show more.
  useEffect(() => {
    const turn = conversation?.turns.at(-1);
    before.current = turn ? turnProgress(turn) : undefined;
    setNow(Date.now());
    if (!slept || !id) return;
    const left = slept.wakeAt + resumeWindowMs - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(timer);
    // Only a new sleep or another session starts the wait again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slept, id]);
  if (!conversation) return null;
  const awake = conversation.keptAwake;
  const awakeKey = `${conversation.id}:${awake?.endedAt}`;
  if (
    awake &&
    dismissedAwake !== awakeKey &&
    preference(settings, "keepAwakeWhileCoding") &&
    conversation.environment?.kind !== "space" &&
    conversation.environment?.kind !== "ssh" &&
    (conversation.turns.at(-1)?.createdAt ?? 0) <= awake.endedAt &&
    (!slept || awake.endedAt > slept.wakeAt) &&
    conversation.turns.at(-1)?.status !== "inProgress"
  ) {
    const battery = preference(settings, "keepAwakeOnBattery");
    const turnOff = async (onlyPluggedIn: boolean) => {
      try {
        await updatePreference(
          onlyPluggedIn
            ? { keepAwakeOnBattery: false }
            : { keepAwakeWhileCoding: false },
        );
        setDismissedAwake(awakeKey);
      } catch (error) {
        onError(error);
      }
    };
    return (
      <NoticeView
        content={{
          kind: "sleep",
          tone: "announcement",
          icon: "coffee",
          title: formatText(
            "Claudex kept your computer awake for {duration}.",
            { duration: awakeDuration(awake.heldMs, locale) },
          ),
          detail: t(
            "This lets long tasks finish. Your computer can sleep as usual now.",
          ),
          action: {
            kind: "retry",
            label: battery ? "Only when plugged in" : "Don’t keep awake",
          },
          ...(battery
            ? {
                secondary: {
                  kind: "retry" as const,
                  label: "Don’t keep awake",
                },
              }
            : {}),
          dismissible: true,
          role: "status",
        }}
        surface="code"
        variant={variant}
        onAction={() => void turnOff(battery)}
        onSecondary={() => void turnOff(false)}
        onDismiss={() => setDismissedAwake(awakeKey)}
      />
    );
  }
  if (!slept) return null;
  const resume = sleepResume(conversation, slept, before.current, now);
  if (!resume && !continuing) return null;
  // Keep computer awake writes only while-working; the battery choice is the
  // person's own, made in Settings, so it is not offered or changed here.
  const keepAwakeOffered =
    keepAwakeRework &&
    (keptAwake || !preference(settings, "keepAwakeWhileCoding"));
  const cloud =
    canContinueInCloud(conversation, host.capabilities.localCode) &&
    !(keepAwakeOffered && resume === "needed");
  const settle = () => {
    settleSleep(conversation.id, slept);
    setSettled((n) => n + 1);
  };
  const keepAwake = async () => {
    if (keptAwake) return;
    try {
      await updatePreference({ keepAwakeWhileCoding: true });
      setKeptAwake(true);
    } catch (error) {
      onError(error);
    }
  };
  const carryOn = async () => {
    if (continuing) return;
    setContinuing(true);
    try {
      if (conversation.turns.at(-1)?.status === "inProgress")
        await api.interrupt(conversation.id).catch(() => undefined);
      await api.send({
        conversationId: conversation.id,
        text: continuePrompt,
        mode: "code",
        attachments: [],
        providerId: conversation.providerId,
        model: conversation.model,
      });
      settle();
    } catch (error) {
      onError(error);
    } finally {
      setContinuing(false);
    }
  };
  const buttons: { label: string; run: () => void; disabled?: boolean }[] = [];
  if (keepAwakeOffered)
    buttons.push({
      label: keptAwake ? "Staying awake" : "Keep computer awake",
      run: () => void keepAwake(),
      disabled: keptAwake,
    });
  if (resume === "needed" || continuing)
    buttons.push({
      label: continuing
        ? "Continuing…"
        : cloud && !keepAwakeOffered
          ? "Continue here"
          : "Continue",
      run: () => void carryOn(),
      disabled: continuing,
    });
  if (cloud)
    buttons.push({
      label: "Continue in cloud",
      run: () => requestContinueInCloud(conversation.id),
      disabled: continuing,
    });
  const [primary, second] = buttons;
  const teach = keepAwakeOffered
    ? keptAwake
      ? "Your computer will stay awake while Claudex works."
      : "Keep your computer awake so long tasks can finish."
    : cloud
      ? "Cloud sessions keep running, even with the lid closed."
      : null;
  const detail = keepAwakeRework
    ? [resume ? t(resumeText[resume]) : null, teach ? t(teach) : null]
        .filter(Boolean)
        .join(" ")
    : formatText(
        "Claudex was working on this when your computer went to sleep at {time} and hasn’t made progress since it woke up.",
        {
          time: new Intl.DateTimeFormat(locale, {
            hour: "numeric",
            minute: "2-digit",
          }).format(slept.suspendedAt),
        },
      );
  const content: NoticeContent = {
    kind: "sleep",
    tone: "announcement",
    icon: "info",
    title: t(sleepTitle(keepAwakeRework, cloud)),
    ...(detail ? { detail } : {}),
    // The first button is the primary one, which sits last.
    ...(primary
      ? {
          secondary: {
            kind: "continue" as const,
            label: primary.label,
            disabled: primary.disabled,
          },
        }
      : {}),
    ...(second
      ? {
          action: {
            kind: "continue" as const,
            label: second.label,
            disabled: second.disabled,
          },
        }
      : {}),
    dismissible: true,
    role: "alert",
  };
  return (
    <div className="composer-notice-slot" data-state="open">
      <div>
        <NoticeView
          content={content}
          surface="code"
          variant={variant}
          onSecondary={primary?.run}
          onAction={second?.run}
          onDismiss={settle}
        />
      </div>
    </div>
  );
}
