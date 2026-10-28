import { useEffect } from "react";

/**
 * The web app's tab icon and browser colours (SCRATCH/impl/web/W-UI-design.md
 * §6.3): the Claudex mark alone, #d97757 strokes without the app icon's plate,
 * as SVG with a 32 px PNG for browsers without SVG icons, a 180 px
 * apple-touch-icon on a dark ground, and `theme-color` following the app's
 * theme.
 *
 * The files live in public-web/; `new URL(…, import.meta.url)` lets the web
 * build emit them under /assets/ (or inline them) without a change to its
 * configuration.
 */
export const faviconUrls = {
  svg: new URL("../../public-web/favicon.svg", import.meta.url).href,
  png: new URL("../../public-web/favicon-32.png", import.meta.url).href,
  touch: new URL("../../public-web/apple-touch-icon.png", import.meta.url).href,
};

/** The browser UI colour of each theme (the app's window background). */
export const themeColors = { dark: "#141414", light: "#fcfcfb" } as const;

export interface HeadLink {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
}

/** The icon links the page carries, in the order browsers prefer them. */
export function faviconLinks(urls = faviconUrls): HeadLink[] {
  return [
    { rel: "icon", href: urls.svg, type: "image/svg+xml", sizes: "any" },
    { rel: "icon", href: urls.png, type: "image/png", sizes: "32x32" },
    { rel: "apple-touch-icon", href: urls.touch, sizes: "180x180" },
  ];
}

/** The theme-color of `<html data-theme>` (set by useAppearance). */
export function themeColor(theme: string | undefined): string {
  return theme === "light" ? themeColors.light : themeColors.dark;
}

/** Marks the head elements this module manages. */
const owner = "data-claudex-web";

/** Adds the icon links, replacing any the page had. */
export function installFavicon(doc: Document = document) {
  for (const old of doc.head.querySelectorAll(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
  ))
    old.remove();
  for (const link of faviconLinks()) {
    const element = doc.createElement("link");
    element.setAttribute(owner, "");
    element.rel = link.rel;
    element.href = link.href;
    if (link.type) element.type = link.type;
    if (link.sizes) element.setAttribute("sizes", link.sizes);
    doc.head.append(element);
  }
}

/** Sets `<meta name="theme-color">` to the theme's colour. */
export function applyThemeColor(doc: Document = document) {
  let meta = doc.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "theme-color";
    meta.setAttribute(owner, "");
    doc.head.append(meta);
  }
  meta.content = themeColor(doc.documentElement.dataset.theme);
}

/**
 * Puts the icons in the page and keeps theme-color in step with the app's
 * theme (which follows the system when asked). Web only: called from
 * useDocumentTitle, which App mounts on the web.
 */
export function useFavicon(): void {
  useEffect(() => {
    installFavicon();
    applyThemeColor();
    const observer = new MutationObserver(() => applyThemeColor());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
}
