import { useOpenLink } from "../../ui/ExternalLinks";
import { t } from "../../i18n";
import "../../ui/markdown-parity.css";

// (live claude.ai bundle, 2026-10-14, shared-11-AyO4lbEo.js).
export function ElectionInfoSource({ url }: { url: string }) {
  const openLink = useOpenLink();
  const [before, after] = t("Source: {source}").split("{source}");
  return (
    <p data-testid="election-info-source" className="election-info-source">
      {before}
      <a
        href={url}
        onClick={(event) => {
          event.preventDefault();
          openLink(url);
        }}
      >
        {t("Democracy Works")}
      </a>
      {after}
    </p>
  );
}
