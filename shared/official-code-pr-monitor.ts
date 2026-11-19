export type OfficialCodePrMonitorOperation =
  "status" | "subscribe" | "unsubscribe" | "mute";

export const officialCodePrMonitorStatusMaxBytes = 48 * 1024;
export const officialCodePrMonitorActionMaxBytes = 2048;
export const officialCodePrMonitorBatchSize = 25;

const statusPath = "/v1/code/github/get-batch-branch-status";

export function officialCodePrMonitorOperation(
  method: string,
  path: string,
): OfficialCodePrMonitorOperation | undefined {
  if (method !== "POST") return;
  const [pathname, search, fragment] = path.split("?");
  if (pathname === statusPath) {
    if (search === undefined) return "status";
    if (fragment !== undefined) return;
    const entries = [...new URLSearchParams(search)];
    if (
      entries.length === 1 &&
      entries[0][0] === "caller" &&
      /^[\w-]{1,128}$/.test(entries[0][1])
    )
      return "status";
    return;
  }
  switch (path) {
    case "/v1/code/github/subscribe-pull-request":
      return "subscribe";
    case "/v1/code/github/unsubscribe-pull-request":
      return "unsubscribe";
    case "/v1/code/github/set-pull-request-address-comments-muted":
      return "mute";
  }
}
