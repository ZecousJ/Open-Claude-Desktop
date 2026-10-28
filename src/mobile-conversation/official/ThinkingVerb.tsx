import { useEffect, useState } from "react";
import { t, useT } from "../../i18n";

/**
 * The official app's thinking verbs. Each is written through t so every
 * catalog carries it.
 */
export const OFFICIAL_THINKING_VERBS = [
  () => t("Thinking"),
  () => t("Sifting"),
  () => t("Fathoming"),
  () => t("Honing"),
  () => t("Weighing"),
  () => t("Pondering"),
  () => t("Contemplating"),
  () => t("Cogitating"),
  () => t("Picturing"),
  () => t("Musing"),
  () => t("Figuring"),
  () => t("Reckoning"),
  () => t("Mulling"),
  () => t("Triangulating"),
  () => t("Crystallizing"),
  () => t("Sleuthing"),
  () => t("Untangling"),
] as const;

/** A new verb every 8000 ms. */
export const THINKING_VERB_MS = 8000;

/** A random verb index other than `previous` (the official picks a different one each time). */
export function nextVerb(previous: number | undefined, random = Math.random) {
  const count = OFFICIAL_THINKING_VERBS.length;
  if (previous === undefined) return Math.floor(random() * count);
  const step = 1 + Math.floor(random() * (count - 1));
  return (previous + step) % count;
}

/**
 * The live thinking label: a random first verb, then a different random one
 * every 8 s, swapped with AnimatedContent's default fade; drawn in the
 * transcript font with the 1500 ms shimmer. The accessible name is "Thinking…".
 */
export function ThinkingVerb() {
  useT();
  const [verb, setVerb] = useState(() => nextVerb(undefined));
  useEffect(() => {
    const timer = window.setInterval(
      () => setVerb((value) => nextVerb(value)),
      THINKING_VERB_MS,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="official-verb" role="status" aria-label={t("Thinking…")}>
      <span key={verb} className="official-verb-text" aria-hidden="true">
        {OFFICIAL_THINKING_VERBS[verb]()}…
      </span>
    </span>
  );
}
