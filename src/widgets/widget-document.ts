import type { WidgetResource } from "../../shared/widget";
import { widgetDomains } from "../../shared/widget";

export function widgetDocument(
  html: string,
  resource?: Pick<WidgetResource, "resourceDomains" | "connectDomains">,
) {
  const domains = widgetDomains({ _meta: { ui: { csp: resource } } });
  const assets = domains.resourceDomains?.join(" ") ?? "";
  const connections = domains.connectDomains?.join(" ") || "'none'";
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${assets}; style-src 'unsafe-inline' ${assets}; img-src data: blob: ${assets}; font-src data: ${assets}; connect-src ${connections}; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
}
