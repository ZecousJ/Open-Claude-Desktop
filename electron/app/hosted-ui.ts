import type { Session } from "electron";

export function hostedUiUrl(
  page: "index.html" | "find.html" | "quick.html",
  query?: Record<string, string>,
  source = process.env.CLAUDEX_UI_URL,
) {
  if (!source) return undefined;
  const root = new URL(source);
  if (root.protocol !== "https:" || root.username || root.password)
    throw new Error(
      "CLAUDEX_UI_URL must be an HTTPS desktop interface URL without credentials.",
    );
  const url = page === "index.html" ? root : new URL(page, root);
  for (const [key, value] of Object.entries(query ?? {}))
    url.searchParams.set(key, value);
  return url.toString();
}

// .
export function warmHostedUi(
  session: Pick<Session, "preconnect" | "fetch" | "resolveProxy">,
  source: string,
  assets = process.env.CLAUDEX_UI_ASSET_URL ?? source,
  log: (...args: unknown[]) => void = console.log,
) {
  const origin = new URL(source).origin;
  const asset = new URL(assets);
  if (asset.protocol !== "https:")
    throw new Error("Interface assets must use HTTPS.");
  session.preconnect({ url: origin, numSockets: 1 });
  session.preconnect({ url: asset.origin, numSockets: 3 });
  const started = Date.now();
  const timer = setTimeout(
    () => log("[bootPreconnect] proxy still unresolved after 2000 ms"),
    2000,
  );
  void session
    .resolveProxy(origin)
    .then(
      (proxy) =>
        log(
          "[bootPreconnect] proxy resolved",
          Date.now() - started,
          proxy.trim().toUpperCase() === "DIRECT" ? "direct" : "proxied",
        ),
      (error) => log("[bootPreconnect] resolveProxy failed", error),
    )
    .finally(() => clearTimeout(timer));
  const signal = AbortSignal.timeout(5000);
  const ping = new URL("ping.txt", asset);
  void session
    .fetch(ping.toString(), {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    })
    .then(async (response) => {
      log(
        "[bootPreconnect] asset warm-up",
        response.ok ? "ok" : "http_error",
        Date.now() - started,
      );
      await response.arrayBuffer();
    })
    .catch((error) =>
      log(
        "[bootPreconnect] asset warm-up",
        signal.aborted ? "timeout" : "error",
        Date.now() - started,
        error,
      ),
    );
}
