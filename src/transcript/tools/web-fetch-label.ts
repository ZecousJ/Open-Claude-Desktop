import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { webFetchPage } from "../../../shared/web-fetch-item";
import { webFetchError } from "../../../shared/web-fetch";
import { formatText, t } from "../../i18n";

export function webFetchLabel(item: Item) {
  const { url, title, hostname } = webFetchPage(item);
  if (itemIsRunning(item))
    return hostname
      ? formatText("Fetching from {hostname}", { hostname })
      : t("Fetching from site");
  const error = webFetchError(item);
  return formatText(
    error ? "Failed to fetch <b>{title}</b>" : "Fetched <b>{title}</b>",
    {
      title: error ? url : title,
    },
  );
}
