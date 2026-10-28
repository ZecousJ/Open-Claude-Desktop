/**
 * The app's small extra pages (the find bar, the quick entry window): each
 * is its own HTML entry built beside index.html (vite.config.ts), loaded
 * with a preload that exposes only that page's calls. They run sandboxed
 * like the app windows, never open windows and never navigate.
 */
import path from "node:path";
import type { WebContents, WebPreferences } from "electron";

export type ExtraPage = "find.html" | "quick.html";

/** Sandboxed, isolated, with only the page's own preload. */
export function extraPagePreferences(
  dirname: string,
  preload: string,
): WebPreferences {
  return {
    preload: path.join(dirname, preload),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  };
}

/** The interface packs' address of a page (electron/ui-pack), when they are on. */
let packUrl: ((page: ExtraPage) => string | undefined) | undefined;
export function setExtraPageUrl(next: typeof packUrl) {
  packUrl = next;
}

/** The page's address: the dev server's while developing, the interface pack's, else the build's file. */
export function extraPageLocation(
  page: ExtraPage,
  dirname: string,
  devUrl = process.env.CLAUDEX_DEV_URL,
): { url: string } | { file: string } {
  if (devUrl) return { url: new URL(page, devUrl).toString() };
  const pack = packUrl?.(page);
  if (pack) return { url: pack };
  return { file: path.join(dirname, "../dist", page) };
}

type PageContents = Pick<
  WebContents,
  "setWindowOpenHandler" | "on" | "loadURL" | "loadFile"
>;

/** Loads an extra page into its contents, which may not open or leave it. */
export function loadExtraPage(
  contents: PageContents,
  page: ExtraPage,
  dirname: string,
) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  const where = extraPageLocation(page, dirname);
  return "url" in where
    ? contents.loadURL(where.url)
    : contents.loadFile(where.file);
}
