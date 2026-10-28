/** A connector IPC mutation captures these server-owned facts before its first
 * await. Call assertCurrent after every await and immediately before writing
 * clients/config/tokens. generation advances at account deactivation, even if
 * the same account/store is later activated again. Never derive this from IPC. */
export interface ConnectorContextIdentity {
  accountId: string | undefined;
  store: object;
  engine: object;
  remote: object | undefined;
  generation: number;
  operation: number;
  configuration: object;
  origin: string;
  /** The configured connector's current identity/address or the validated new target. */
  resource: string;
}
export function captureConnectorContext(read: () => ConnectorContextIdentity) {
  const captured = { ...read() };
  const current = () => {
    try {
      const next = read();
      return (
        !!captured.accountId &&
        next.accountId === captured.accountId &&
        next.store === captured.store &&
        next.engine === captured.engine &&
        next.remote === captured.remote &&
        next.generation === captured.generation &&
        next.operation === captured.operation &&
        next.configuration === captured.configuration &&
        next.origin === captured.origin &&
        next.resource === captured.resource
      );
    } catch {
      return false;
    }
  };
  return {
    current,
    assertCurrent() {
      if (!current())
        throw Error(
          "This connector operation belongs to a retired account or connector. Open it again.",
        );
    },
  };
}

/** OAuth handoff is an external navigation; credentials and active schemes are
 * never accepted. Plain HTTP is limited to the runtime's loopback callback. */
export function connectorSignInUrl(address: unknown): string {
  const failure = "The connector didn't return a sign-in page.";
  if (typeof address !== "string") throw Error(failure);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw Error(failure);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw Error(failure);
  return url.href;
}
