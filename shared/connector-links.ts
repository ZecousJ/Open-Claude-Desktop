export function connectorShareLink(
  id: string,
  location: string,
  desktop: boolean,
) {
  const link = new URL(
    desktop ? "claudex://settings/connectors" : "/settings/connectors",
    location,
  );
  link.searchParams.set("connector", id);
  return link.href;
}

export function desktopConnectorLink(href: string) {
  try {
    const link = new URL(href);
    const id = link.searchParams.get("connector");
    const suggestion = connectorSuggestion(href);
    return link.protocol === "claudex:" &&
      link.hostname === "settings" &&
      link.pathname === "/connectors" &&
      !link.username &&
      !link.password &&
      ((id && id.length <= 256) || suggestion)
      ? suggestion
        ? `suggested:${JSON.stringify(suggestion)}`
        : id!
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ConnectorSuggestion {
  name: string;
  url: string;
}

// Deep-link prefill.
export function connectorSuggestion(
  href: string,
): ConnectorSuggestion | undefined {
  try {
    const params = new URL(href).searchParams;
    const encoded = params.get("connector");
    if (encoded?.startsWith("suggested:") && encoded.length <= 4096) {
      const value = JSON.parse(encoded.slice(10));
      if (
        typeof value?.name === "string" &&
        value.name.length <= 128 &&
        typeof value.url === "string" &&
        value.url.length <= 2048 &&
        value.url.trim()
      )
        return { name: value.name, url: value.url };
      return undefined;
    }
    const name = params.get("connectorName")?.trim() ?? "";
    const url = params.get("connectorUrl")?.trim();
    if (name.length <= 128 && url && url.length <= 2048) return { name, url };
  } catch {}
  return undefined;
}
