import { Suspense, useEffect, useRef, useState } from "react";
import { ChevronRight } from "../ui/glyphs";
import type { Conversation } from "../../shared/types";
import { computerUseServerName } from "../../shared/computer-use";
import { resultScreenshots } from "../computer-use/labels";
import { useScreenshot } from "../computer-use/ScreenshotLightbox";
import { useComputerUse } from "../computer-use/useComputerUse";
import { formatText } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";

const ComputerUseActivityDetail = lazyPiece(
  () => import("./ComputerUseActivityDetail"),
  "ComputerUseActivityDetail",
);

export function computerUseItems(conversation: Conversation) {
  return conversation.turns
    .flatMap((turn) => turn.items)
    .filter(
      (item) =>
        item.type === "mcpToolCall" && item.server === computerUseServerName,
    );
}

// Live and historical frames share a collapsible card.
export function ComputerUseActivity({
  conversation,
}: {
  conversation: Conversation;
}) {
  const state = useComputerUse();
  const activity =
    state?.activity?.conversationId === conversation.id
      ? state.activity
      : undefined;
  const active = Boolean(activity);
  const items = computerUseItems(conversation);
  const shot = items.flatMap((item) => resultScreenshots(item.result)).at(-1);
  const saved = useScreenshot(shot ?? { url: "" }, "full");
  const running = conversation.turns.some(
    (turn) => turn.status === "inProgress",
  );
  const [expanded, setExpanded] = useState(running);
  const preference = useRef<"expanded" | "collapsed">(undefined);
  const [detail, setDetail] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (running && (active || saved) && preference.current !== "collapsed")
      setExpanded(true);
    else if (!running && preference.current !== "expanded") setExpanded(false);
  }, [running, active, saved]);
  const watching = expanded || detail;
  useEffect(() => {
    if (!active || !watching || !window.desktop?.computerUsePreview) return;
    if ("computerUseSetSubscribed" in window.desktop) {
      const bridge = window.desktop;
      const subscribe = () =>
        void bridge
          .computerUseSetSubscribed(conversation.id, !document.hidden, 4)
          .catch(() => undefined);
      const off = bridge.onEvent((event) => {
        if (
          event.type === "computer-use" &&
          event.frame?.conversationId === conversation.id
        )
          setFrame(event.frame.dataUrl);
      });
      document.addEventListener("visibilitychange", subscribe);
      subscribe();
      return () => {
        off();
        document.removeEventListener("visibilitychange", subscribe);
        void bridge
          .computerUseSetSubscribed(conversation.id, false)
          .catch(() => undefined);
        setFrame(null);
      };
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (disposed) return;
      if (document.visibilityState !== "hidden") {
        const next = await window.desktop
          .computerUsePreview(conversation.id)
          .catch(() => null);
        if (!disposed) setFrame(next);
      }
      if (!disposed) timer = setTimeout(read, 1000);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, watching, conversation.id]);
  if (!active && !items.length) return null;
  const source = (active && frame) || saved;
  return (
    <section className="progress-computer-use" aria-label="Computer use">
      <button
        className="progress-computer-heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          preference.current = expanded ? "collapsed" : "expanded";
          setExpanded(!expanded);
        }}
      >
        <span>Computer use</span>
        <ChevronRight size={20} className={expanded ? "expanded" : ""} />
      </button>
      {expanded && (
        <div className="progress-computer-content">
          <button
            className="progress-computer-frame"
            type="button"
            aria-label="Open computer use activity"
            onClick={() => setDetail(true)}
          >
            {source ? (
              <img src={source} alt="" draggable={false} />
            ) : (
              <div className="progress-computer-empty">
                <p>
                  Claudex is working on your computer. You’ll see updates here
                  as Claudex makes progress.
                </p>
              </div>
            )}
          </button>
          {activity && (
            <p className="progress-computer-caption">
              <span className="progress-computer-mode">
                <span className="progress-live">Live</span>
                {formatText(
                  activity.mode === "fullControl"
                    ? "Full control · {target}"
                    : "Background · {target}",
                  { target: activity.app?.name ?? "" },
                )}
              </span>
            </p>
          )}
        </div>
      )}
      {detail && (
        <Suspense fallback={null}>
          <ComputerUseActivityDetail
            items={items}
            source={source || undefined}
            onClose={() => setDetail(false)}
          />
        </Suspense>
      )}
    </section>
  );
}
