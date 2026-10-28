import { useOpenLink } from "../../ui/ExternalLinks";
import { t } from "../../i18n";
import "../../ui/markdown-parity.css";

// .
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
