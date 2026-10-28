import type { CitationGroup } from "./citations";
import { siteName } from "./citations";
import { SiteIcon } from "./SiteIcon";

/** "wikipedia" → "Wikipedia": a site's name as the card writes it. */
const titled = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The card a citation pill shows on hover or focus: one link for every page the
 * pill cites, each with its title (medium, up to two lines) and the site's icon
 * and name under it. Everything shown is text from the web, rendered as text.
 */
export function CitationCard({
  group,
  onOpen,
}: {
  group: CitationGroup;
  onOpen: (url: string) => void;
}) {
  return (
    <>
      {group.sources.map((source) => (
        <a
          key={source.url}
          className="citation-card-item"
          href={source.url}
          title={source.url}
          onClick={(event) => {
            event.preventDefault();
            onOpen(source.url);
          }}
        >
          <span className="citation-card-title">
            {source.title ?? source.url}
          </span>
          <span className="citation-card-site">
            <SiteIcon host={source.host} size={14} />
            <span className="citation-card-host">
              {titled(siteName(source.host))}
            </span>
          </span>
        </a>
      ))}
    </>
  );
}
