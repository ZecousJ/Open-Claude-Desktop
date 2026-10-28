import { useEffect, useRef, useState, type CSSProperties } from "react";
import { prefersReducedMotion } from "../ui/usePresence";
import { graphemes, titleOutMs, titleRevealMs } from "./title-motion";

/**
 * A conversation title that writes itself in when it changes (the first reply's
 * automatic title, a rename elsewhere): the old title fades out and blurs over
 * 200ms, then the new one appears a character at a time, each sharpening from a
 * 6px blur over 90ms, 30ms apart. The first title a row shows is drawn at once,
 * and a change that arrives while the last one is still writing waits for it.
 * Reduced motion swaps the text. Renders a span for the row's title slot
 * (sidebar.css .title-motion).
 */
export function TitleReveal({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<"still" | "out" | "in">("still");
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (phase !== "still" || text === shown) return;
    if (prefersReducedMotion()) setShown(text);
    else setPhase("out");
  }, [text, shown, phase]);
  useEffect(() => {
    if (phase === "out") {
      const timer = setTimeout(() => {
        // Changed back while fading: the old title simply returns.
        if (latest.current === shown) return setPhase("still");
        setShown(latest.current);
        setPhase("in");
      }, titleOutMs);
      return () => clearTimeout(timer);
    }
    if (phase === "in") {
      const timer = setTimeout(
        () => setPhase("still"),
        titleRevealMs(graphemes(shown).length),
      );
      return () => clearTimeout(timer);
    }
  }, [phase, shown]);
  if (phase !== "in")
    return (
      <span className="title-motion" data-phase={phase}>
        {shown}
      </span>
    );
  return (
    <>
      <span className="sr-only">{shown}</span>
      <span key={shown} className="title-motion" data-phase="in" aria-hidden>
        {graphemes(shown).map((part, index) => (
          <span key={index} style={{ "--i": index } as CSSProperties}>
            {part}
          </span>
        ))}
      </span>
    </>
  );
}
