/**
 * Leaving the app: external links, remote Markdown images and the update's
 * download page, all checked against the administrator's policy in
 * `electron/external-links.ts`.
 */
import { bridgeMethods } from "./bridge-methods";

export interface ExternalLinksAPI {
  setRoutedLinkConfirmReady(ready: boolean): Promise<void>;
  resolveRoutedLinkConfirm(requestId: string, allow: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Fetches a remote Markdown image as a data: URL after the person chose to load it. */
  loadRemoteImage(url: string): Promise<string>;
  /**
   * Opens the published update's download page. The main process takes the
   * address from the service's release information and opens it only when
   * it is https; the window never passes one.
   */
  openUpdateDownload(): Promise<void>;
}

export const externalLinksMethods = bridgeMethods<ExternalLinksAPI>({
  setRoutedLinkConfirmReady: true,
  resolveRoutedLinkConfirm: true,
  openExternal: true,
  loadRemoteImage: true,
  openUpdateDownload: true,
});
