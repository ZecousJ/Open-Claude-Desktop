import {
  officialShareAddressPath,
  officialShareId,
  parseOfficialShareAddress,
} from "../../shared/official-share-link";
import { cookieName } from "./server";

export function openOfficialShareLink({
  target,
  origin,
  token,
  current,
  open,
}: {
  target: URL;
  origin: string;
  token: string;
  current: () => boolean;
  open: (address: string) => Promise<void>;
}): Promise<void> | undefined {
  const id = officialShareId(target, origin, true);
  if (!id) return;
  return (async () => {
    if (!current()) return;
    const response = await fetch(
      new URL(officialShareAddressPath(id), origin),
      {
        headers: { Cookie: `${cookieName}=${token}` },
        redirect: "error",
      },
    );
    if (
      !current() ||
      !response.ok ||
      !/^text\/plain(?:;|$)/i.test(response.headers.get("content-type") ?? "")
    )
      return;
    const address = parseOfficialShareAddress(await response.text(), origin);
    if (current()) await open(address);
  })();
}
