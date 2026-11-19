export const officialShareIdPattern = "[A-Za-z0-9_-]{1,64}";
const originalSharePath = new RegExp(`^/share/(${officialShareIdPattern})$`);

export function officialShareId(
  address: URL,
  origin: string,
  allowBrowserMarker = false,
) {
  if (
    address.origin === origin &&
    !address.username &&
    !address.password &&
    (!address.search ||
      (allowBrowserMarker && address.search === "?open_in_browser=1")) &&
    !address.hash
  )
    return originalSharePath.exec(address.pathname)?.[1];
}

export function officialShareAddressPath(id: string) {
  return `/api/__claudex/share-url/${id}`;
}

export function parseOfficialShareAddress(raw: string, origin: string) {
  if (!raw || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw))
    throw Error("The shared link is invalid.");
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.origin === origin && /^\/share(?:\/|$)/.test(url.pathname))
  )
    throw Error("The shared link is invalid.");
  return url.href;
}
