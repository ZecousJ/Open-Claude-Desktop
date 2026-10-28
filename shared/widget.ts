import type { Item } from "./types";

export interface WidgetResource {
  html: string;
  uri: string;
  server: string;
  resourceDomains?: string[];
  connectDomains?: string[];
}

export function widgetDomains(
  value: unknown,
): Pick<WidgetResource, "resourceDomains" | "connectDomains"> {
  const csp = (
    value as { _meta?: { ui?: { csp?: Record<string, unknown> } } } | null
  )?._meta?.ui?.csp;
  const domains = (entries: unknown) =>
    Array.isArray(entries)
      ? entries
          .flatMap((entry) => {
            if (typeof entry !== "string") return [];
            try {
              const url = new URL(entry);
              return ["https:", "http:"].includes(url.protocol) &&
                !url.username &&
                !url.password &&
                url.pathname === "/" &&
                !url.search &&
                !url.hash
                ? [url.origin]
                : [];
            } catch {
              return [];
            }
          })
          .slice(0, 32)
      : [];
  return {
    resourceDomains: domains(csp?.resourceDomains),
    connectDomains: domains(csp?.connectDomains),
  };
}

export function widgetUri(value: unknown): string | undefined {
  const uri = (
    value as {
      _meta?: { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown };
    } | null
  )?._meta;
  const resource = uri?.ui?.resourceUri ?? uri?.["ui/resourceUri"];
  return typeof resource === "string" && resource.startsWith("ui://")
    ? resource
    : undefined;
}

export function embeddedWidget(
  result: unknown,
): { html: string; uri: string } | undefined {
  const content = (
    result as {
      content?: {
        type?: string;
        resource?: { uri?: string; mimeType?: string; text?: string };
      }[];
    } | null
  )?.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    const resource = entry?.resource;
    if (
      entry?.type === "resource" &&
      resource?.mimeType?.split(";")[0] === "text/html" &&
      typeof resource.text === "string" &&
      resource.text.length <= 2_000_000
    )
      return { html: resource.text, uri: resource.uri ?? "" };
  }
}

export function sessionWidgets(turns: { items: Item[] }[]): Item[] {
  return turns
    .flatMap((turn) => turn.items)
    .filter(
      (item) =>
        item.type === "mcpToolCall" &&
        typeof item.server === "string" &&
        typeof item.tool === "string",
    );
}
