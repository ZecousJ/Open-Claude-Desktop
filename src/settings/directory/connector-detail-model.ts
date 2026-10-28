import type { CatalogueConnector } from "../../../shared/connectors-catalogue";

/** Published links stay optional; a name or server address is not a website. */
export function connectorPublishedUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    // Product help and vendor policy links use the local help center.
    if (/(^|\.)(claude\.(ai|com)|anthropic\.com)$/i.test(url.hostname))
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function connectorSupportUrl(value?: string) {
  const website = connectorPublishedUrl(value);
  if (website || !value) return website;
  try {
    const url = new URL(value);
    return url.protocol === "mailto:" &&
      !url.search &&
      !url.hash &&
      /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function connectorCategories(entry?: CatalogueConnector) {
  return [
    ...new Set(
      (entry?.categories ?? (entry?.topic ? [entry.topic] : []))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** Only explicitly related directory records are presented as related. */
export function relatedConnectors(
  entry: CatalogueConnector,
  catalogue: CatalogueConnector[],
) {
  const seen = new Set([entry.id]);
  return (entry.relatedIds ?? []).flatMap((id) => {
    const found = catalogue.find(
      (candidate) => candidate.id === id || candidate.directoryId === id,
    );
    if (!found || seen.has(found.id)) return [];
    seen.add(found.id);
    return [found];
  });
}

export const connectorDetailPath = (id: string) =>
  `/customize/connectors/id/${encodeURIComponent(id)}`;

/**
 * Names are sorted, capped at18 until expanded, then arranged in one, two (6+)
 * or three (11+) columns.
 */
export function connectorToolNames(tools: readonly string[], expanded = false) {
  const sorted = [...tools].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  const clipped = !expanded && sorted.length > 18;
  const names = clipped ? sorted.slice(0, 18) : sorted;
  return {
    names,
    clipped,
    columns: names.length >= 11 ? 3 : names.length >= 6 ? 2 : 1,
  };
}

export function connectorReview(entry?: CatalogueConnector) {
  return !entry
    ? "Not reviewed in the source directory"
    : entry.type === "verified"
      ? "Verified in the source directory"
      : "Not verified in the source directory";
}
