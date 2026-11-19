import { AsyncLocalStorage } from "node:async_hooks";
import type http from "node:http";
import { officialAccountActivation } from "../../shared/official-account-menu";
import { needsSignInAgain } from "../../shared/sign-in-api";
export interface RetirableResponse { finished: Promise<void>; abort(): void }
export interface ResponseLease { current(): boolean; trackResponse?(response: RetirableResponse): void }
type TerminalOutcome =
  | { kind: "pending" | "success" | "failure" | "reauth_required" }
  | { kind: "switched"; id: string };
interface ResponseAuthority { lease: ResponseLease; terminal?: TerminalOutcome; ended: boolean }
const requests = new AsyncLocalStorage<ResponseAuthority>();
/** Main-owned call site only: no header/path can grant this exception. */
export function authorizeRetiredTerminalResponse(lease: ResponseLease, method: string, target?: unknown) {
  if (!["logoutAccount", "revokeAllSessions", "deleteAccount", "addAccount", "switchAccount"].includes(method)) return;
  const authority = requests.getStore();
  if (!authority || authority.lease !== lease || authority.ended || !lease.current())
    throw new Error("The account response no longer belongs to this operation.");
  authority.terminal = { kind: "pending" };
  return (success: boolean, result?: unknown) => {
    if (authority.ended || authority.terminal?.kind !== "pending") return;
    if (method !== "switchAccount") {
      authority.terminal = { kind: success ? "success" : "failure" };
    } else if (success && typeof target === "string" &&
        result && typeof result === "object" && "id" in result && result.id === target) {
      authority.terminal = { kind: "switched", id: target };
    } else {
      authority.terminal = { kind: !success && needsSignInAgain(result) ? "reauth_required" : "failure" };
    }
  };
}
/** Keep the write fence installed for asynchronous streams until the response closes. */
export function withResponseLease<T>(lease: ResponseLease, res: http.ServerResponse, run: () => T): T {
  const authority: ResponseAuthority = { lease, ended: false };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const writeHead = res.writeHead, write = res.write, end = res.end;
  let refused = false;
  const permit = () => {
    if (refused || authority.ended) return false;
    let current = false;
    try { current = lease.current(); } catch {}
    if (current) return true;
    refused = true;
    if (!res.headersSent)
      for (const name of res.getHeaderNames?.() ?? []) res.removeHeader(name);
    if (res.headersSent) res.destroy();
    else {
      const headers = { "Cache-Control": "no-store" };
      const json = (status: number, body: unknown) => {
        writeHead.call(res, status, { ...headers, "Content-Type": "application/json" });
        end.call(res, JSON.stringify(body), "utf8");
      };
      switch (authority.terminal?.kind) {
        case "success":
          writeHead.call(res, 204, headers);
          end.call(res, "", "utf8");
          break;
        case "switched":
          json(200, officialAccountActivation({ id: authority.terminal.id }));
          break;
        case "reauth_required":
          json(401, { type: "error", error: { type: "reauth_required", message: "Sign in again." } });
          break;
        case "failure":
          json(400, { error: { type: "account_transition_error", message: "The account operation could not be confirmed." } });
          break;
        default:
          writeHead.call(res, 410, { ...headers, "Content-Type": "text/plain" });
          end.call(res, "This account window has retired. Reopen the interface.", "utf8");
      }
    }
    return false;
  };
  res.writeHead = function (this: http.ServerResponse, ...args: Parameters<typeof writeHead>) {
    return permit() ? writeHead.apply(this, args) : this;
  } as typeof writeHead;
  res.write = function (this: http.ServerResponse, ...args: Parameters<typeof write>) {
    return permit() ? write.apply(this, args) : false;
  } as typeof write;
  res.end = function (this: http.ServerResponse, ...args: Parameters<typeof end>) {
    return permit() ? end.apply(this, args) : this;
  } as typeof end;
  const flushHeaders = res.flushHeaders, earlyHints = res.writeEarlyHints;
  const writeContinue = res.writeContinue, writeProcessing = res.writeProcessing;
  const addTrailers = res.addTrailers;
  res.flushHeaders = () => { if (permit()) flushHeaders.call(res); };
  res.writeEarlyHints = (...args: Parameters<typeof earlyHints>) => { if (permit()) earlyHints.apply(res, args); };
  res.writeContinue = (...args: Parameters<typeof writeContinue>) => { if (permit()) writeContinue.apply(res, args); };
  res.writeProcessing = () => { if (permit()) writeProcessing.call(res); };
  res.addTrailers = (...args: Parameters<typeof addTrailers>) => { if (permit()) addTrailers.apply(res, args); };
  const close = () => {
    authority.ended = true;
    finish();
    res.removeListener("finish", close); res.removeListener("close", close);
    // Do not restore unfenced methods: a late producer must not write after close.
  };
  res.once("finish", close); res.once("close", close);
  lease.trackResponse?.({ finished, abort: () => res.destroy() });
  return requests.run(authority, run);
}
