/**
 * Calls that do not exist on the web (local folders, terminals, windows,
 * SSH, computer use…). The interface hides their entries (useHost()); a
 * call that still arrives is refused with the same sentence the runner's
 * Electron shim uses, and a development build logs where it came from so
 * the entry that should be hidden can be found.
 */
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import { webErrorCodes } from "../../shared/web-protocol";
import { bridgeError } from "../../shared/web-client/errors";

export function absentMethod(name: string, development: boolean) {
  return async (): Promise<never> => {
    if (development)
      console.error(
        new Error(`window.desktop.${name}() is not available on the web.`),
      );
    throw bridgeError(notAvailableOnWeb, webErrorCodes.methodUnavailable);
  };
}
