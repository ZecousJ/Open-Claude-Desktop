import { useMemo } from "react";
import type { Turn } from "../../../shared/types";
import { sourceKey } from "../../../shared/research";
import {
  citationRender,
  sourceHost,
  turnSources,
} from "../../citations/citations";
import { SiteIcon } from "../../citations/SiteIcon";
import { t, tf, useT } from "../../i18n";
import { OfficialSheet, useSheetStack } from "./OfficialSheet";
import { SourcesList } from "./SourcesList";

/** The pages a finished reply cites, in the order it first cites them. */
export function citedSources(turn: Turn) {
  const known = turnSources(turn);
  const seen = new Map<string, { url: string; title?: string }>();
  for (const item of turn.items) {
    if (item.type !== "agentMessage") continue;
    for (const group of citationRender(item, known)?.groups ?? [])
      for (const source of group.sources) {
        const key = sourceKey(source.url);
        if (key && !seen.has(key))
          seen.set(key, { url: source.url, title: source.title });
      }
  }
  return [...seen.values()];
}

/**
 * The reply row's sources chip: the favicons of up to three different sites, 20
 * dp, each overlapping the last by 8 dp with a 2 dp ring, then "N sources" in
 * 13 sp, 6 dp in from each side, at the row's end. A tap opens the sources
 * ("View sources"). Only replies that cite pages have one.
 */
export function SourcesChip({ turn }: { turn: Turn }) {
  useT();
  const sources = useMemo(() => citedSources(turn), [turn]);
  const sheet = useSheetStack();
  if (turn.status !== "completed" || !sources.length) return null;
  const hosts = [
    ...new Set(sources.map((source) => sourceHost(source.url)).filter(Boolean)),
  ].slice(0, 3) as string[];
  const label =
    sources.length === 1
      ? t("1 source")
      : tf("{n} sources", { n: sources.length });
  return (
    <>
      <button
        type="button"
        className="official-sources-chip"
        aria-haspopup="dialog"
        title={t("View sources")}
        onClick={() => sheet.open("sources")}
      >
        <span className="official-icon-stack" aria-hidden="true">
          {hosts.map((host) => (
            <span className="official-icon-stack-item" key={host}>
              <SiteIcon host={host} size={20} />
            </span>
          ))}
        </span>
        <span>{label}</span>
      </button>
      <OfficialSheet
        pages={sheet.pages.map((key) => ({
          key,
          title: t("Sources"),
          body: () => <SourcesList sources={sources} />,
        }))}
        onBack={sheet.back}
        onClose={sheet.close}
      />
    </>
  );
}
