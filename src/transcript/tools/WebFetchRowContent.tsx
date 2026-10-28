import { useState } from "react";
import { WebFetchIcon } from "./WebFetchIcon";
import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { webFetchPage } from "../../../shared/web-fetch-item";
import { webFetchError } from "../../../shared/web-fetch";
import { externalUrl, useOpenLink } from "../../ui/ExternalLinks";
import { useFavicons } from "../../research/useFavicons";
import { ActivityLabel } from "../TurnActivity";
import { t } from "../../i18n";
import { WebFetchError } from "./WebFetchError";
import { webFetchLabel } from "./web-fetch-label";

/** Fetch cell. */
export function WebFetchRow({ item }: { item: Item }) {
  const { url, title: pageTitle, hostname } = webFetchPage(item);
  const running = itemIsRunning(item);
  const error = webFetchError(item);
  const title = error ? url : pageTitle;
  const icon = useFavicons(hostname ? [hostname] : [])[hostname ?? ""];
  const [brokenIcon, setBrokenIcon] = useState<string>();
  const openLink = useOpenLink();
  const href = externalUrl(url);
  const template = t(
    error ? "Failed to fetch <b>{title}</b>" : "Fetched <b>{title}</b>",
  );
  const parts = template.split("<b>{title}</b>");
  return (
    <div className="chat-step web-fetch-step">
      <a
        className="chat-step-row web-fetch-row"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          if (href) openLink(href);
        }}
      >
        {icon && brokenIcon !== icon ? (
          <img
            className="site-icon"
            src={icon}
            width={16}
            height={16}
            alt=""
            onError={() => setBrokenIcon(icon)}
          />
        ) : (
          <WebFetchIcon name="Globe" />
        )}
        {running ? (
          <ActivityLabel className="chat-step-text" quiet phase="tools">
            {webFetchLabel(item)}
          </ActivityLabel>
        ) : (
          <span className="chat-step-text">
            {parts[0]}
            <span
              className="web-fetch-title"
              dir={title === url ? "ltr" : undefined}
            >
              {title}
            </span>
            {parts[1]}
          </span>
        )}
        {!running && hostname && (
          <span className="web-fetch-host">{hostname}</span>
        )}
        <WebFetchError item={item} />
        {href && <WebFetchIcon name="ArrowOutSquare" />}
      </a>
    </div>
  );
}
