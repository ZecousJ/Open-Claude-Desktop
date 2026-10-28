import { useOpenLink } from "../../ui/ExternalLinks";
import { siteName, sourceHost } from "../../citations/citations";
import { SiteIcon } from "../../citations/SiteIcon";

/**
 * The Sources page: one row per page, its site icon, its title and its site; a
 * tap opens it through the native link confirmation. Titles come from web pages
 * and are shown as text only.
 */
export function SourcesList({
  sources,
}: {
  sources: { url: string; title?: string }[];
}) {
  const openLink = useOpenLink();
  return (
    <ul className="official-source-list">
      {sources.map((source) => {
        const host = sourceHost(source.url);
        if (!host) return null;
        return (
          <li key={source.url}>
            <button
              type="button"
              className="official-source"
              onClick={() => openLink(source.url)}
            >
              <SiteIcon host={host} size={20} />
              <span className="official-source-text">
                <span className="official-source-title">
                  {source.title?.trim() || siteName(host)}
                </span>
                <span className="official-source-host">{host}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
