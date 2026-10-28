import { useDocumentTitle } from "../web/document-title";
import { useWebRoute } from "../web/useWebRoute";

/**
 * The web app's window-wide hooks (URL routing, tab title). App renders this
 * inside AppContext on the web only; it renders nothing itself.
 */
export function WebMounts() {
  useWebRoute();
  useDocumentTitle();
  return null;
}
