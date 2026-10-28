import type { HostedShare, SharingStatus } from "../../shared/sharing-api";

/** Only a current service link can be copied; invited links keep their audience. */
export function conversationShareUrl(share: HostedShare | null | undefined) {
  if (
    share?.status !== "active" ||
    (share.expiresAt !== undefined && share.expiresAt <= Date.now())
  )
    return undefined;
  const value =
    share.access === "invited" ? (share.inviteUrl ?? share.url) : share.url;
  try {
    const url = new URL(value);
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** A blocked account may still copy/revoke an existing link, never create access. */
export function conversationShareWritable(
  status: SharingStatus | null | undefined,
  share?: HostedShare | null,
) {
  return Boolean(
    status?.conversations && !status.blocked && share?.status !== "disabled",
  );
}
