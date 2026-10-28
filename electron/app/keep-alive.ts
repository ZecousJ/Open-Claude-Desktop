import { Agent, setGlobalDispatcher } from "undici";

/**
 * `fetch` keeps a connection open for 4 s after a request by default, so a
 * request a few seconds after the last one opens a new TCP and TLS
 * connection: three round trips to the service (about 0.6 s from China),
 * and many seconds when a SYN is lost on the way. Connections now stay open
 * for 100 s between requests, under the service's nginx keep-alive (120 s).
 */
export function keepConnectionsOpen() {
  setGlobalDispatcher(
    new Agent({ keepAliveTimeout: 100_000, keepAliveMaxTimeout: 100_000 }),
  );
}
