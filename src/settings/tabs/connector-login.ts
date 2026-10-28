import type { ConnectorOperation } from "../connector-owner";

/** The optional operation is supplied by owner-aware leaves. Existing page
 * callers must pass their captured operation before central integration closes. */
export async function connectCustomConnector(
  name: string,
  local: boolean,
  operation?: ConnectorOperation,
  navigate: (address: string) => void = (address) =>
    window.location.assign(address),
) {
  const bridge = operation?.bridge ?? window.desktop;
  const origin = window.location.origin;
  const current = () =>
    (!operation || operation.current()) &&
    window.desktop === bridge &&
    window.location.origin === origin;
  if (!current()) return;
  const callback = local ? undefined : new URL(window.location.href);
  callback?.searchParams.set("cowork_connector", "1");
  callback?.searchParams.set("connector", `installed:${name}`);
  try {
    const address = await bridge.connectConnector(name, callback?.href);
    if (!current()) return;
    if (address) {
      const target = new URL(address);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        target.hostname,
      );
      if (
        target.username ||
        target.password ||
        (target.protocol !== "https:" &&
          !(local && target.protocol === "http:" && loopback))
      )
        throw Error("The connector didn’t return a supported sign-in page.");
      navigate(target.href);
    }
  } catch (error) {
    if (!current()) return;
    throw error;
  }
}
