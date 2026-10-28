import { useEffect } from "react";
import { useApp } from "../app/AppContext";
import { documentTitle } from "../web/document-title";

/**
 * The desktop main window's page title: the open conversation or page, as
 * on the web (the main process turns "Title - Claudex" into the window's
 * "Title — Claudex", electron/window-title.ts). Renders nothing.
 */
export function DesktopTitle() {
  const app = useApp();
  const title = documentTitle({
    page: app.page,
    mode: app.mode,
    conversation: app.active,
    incognitoShown: app.incognitoShown,
    settingsOpen: app.settingsOpen,
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
