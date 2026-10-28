import { useFavicons } from "../research/useFavicons";
import type { ReactNode } from "react";

/**
 * A site's icon for a search result or citation card: its favicon where
 * remote images are allowed, otherwise a round placeholder with the site's
 * first letter.
 */
export function SiteIcon({
  host,
  size = 16,
  fallback,
}: {
  host: string;
  size?: number;
  fallback?: ReactNode;
}) {
  const icon = useFavicons([host])[host];
  const style = { width: size, height: size };
  if (icon)
    return (
      <img
        className="site-icon"
        src={icon}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={style}
      />
    );
  const letter = Array.from(host.replace(/^www\./, ""))[0] ?? "?";
  return (
    <span
      className="site-icon site-icon-placeholder"
      aria-hidden="true"
      style={{ ...style, fontSize: Math.round(size * 0.62) }}
    >
      {fallback ?? letter.toUpperCase()}
    </span>
  );
}
