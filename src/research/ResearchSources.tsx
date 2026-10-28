import type { WebSource } from "../../shared/research";
import { turnSourceUrls } from "../../shared/research";
import type { Turn } from "../../shared/types";
import { SiteIcon } from "../citations/SiteIcon";
import { sourceHost, turnSources } from "../citations/citations";
import { useOpenLink } from "../ui/ExternalLinks";
import { t } from "../i18n";

/**
 * Every distinct page a Research turn's searches returned or its replies
 * cited, newest first (the Gathering sources list puts new pages on top).
 * Pages known only from a citation keep their address as the title.
 */
export function researchSources(turn: Pick<Turn, "items">): WebSource[] {
  const known = turnSources(turn);
  const sources: WebSource[] = [];
  for (const url of turnSourceUrls(turn))
    sources.push(known.get(url) ?? { url });
  return sources.reverse();
}

/** A Research turn's sources as rows (design R45 §4.4, rows as §4.5). */
export function ResearchSources({ sources }: { sources: WebSource[] }) {
  const openLink = useOpenLink();
  if (!sources.length)
    return <p className="research-sources-empty">{t("No sources found")}</p>;
  return (
    <ul className="research-sources" aria-label={t("Sources")}>
      {sources.map((source) => {
        const host = sourceHost(source.url) ?? source.url;
        return (
          <li key={source.url}>
            <a
              className="web-search-result"
              href={source.url}
              title={source.url}
              onClick={(event) => {
                event.preventDefault();
                openLink(source.url);
              }}
            >
              <SiteIcon host={host} />
              <span className="web-search-result-title">
                {source.title || source.url}
              </span>
              <span className="web-search-result-host">{host}</span>
            </a>
            {source.snippet && (
              <details className="research-source-snippet">
                <summary>{source.title || host}</summary>
                <p>{source.snippet}</p>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
