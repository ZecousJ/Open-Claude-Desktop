import type { SharingStatus } from "../../shared/sharing-api";

/**
 * The status the Share button opens the dialog with, or null for no button:
 * the service offers conversation sharing, or the conversation already has
 * a link (so it can still be stopped after the administrator turns sharing
 * off), as in the main title bar.
 */
export function shareButtonStatus(
  status: SharingStatus | null | undefined,
  hasShare: boolean,
): SharingStatus | null {
  return status && (status.conversations || hasShare) ? status : null;
}
