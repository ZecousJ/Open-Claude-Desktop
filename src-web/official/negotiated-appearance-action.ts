import {
  officialAppearanceCapabilitiesPath,
  officialAppearanceFonts,
  isOfficialAppearanceAction,
  isOfficialLocaleAction,
  validAppearanceBody,
  validLocaleBody,
  type OfficialAppearanceCapability,
} from "../../shared/official-appearance-capability";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
type Call = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
export function negotiatedAppearanceSettings(input: {
  enabled: boolean;
  accountId: string;
  current(): boolean;
  read: Call;
  action: Call;
  onStatus?(message: string): void;
}): Call {
  let sequence = 0;
  return async (request) => {
    const operation = ++sequence;
    const localeAction = isOfficialLocaleAction(request.method, request.path);
    const report = (message: string) => {
      if (operation === sequence && input.current()) input.onStatus?.(message);
    };
    const refuse = (
      status: number,
      message: string,
    ): OfficialUiReadResponse => {
      if (localeAction)
        message = "Language changes are not available on this host.";
      else report(message);
      return {
        status,
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ error: { message } })),
      };
    };
    if (!input.current())
      return refuse(
        409,
        "The account activation changed. No appearance change was sent.",
      );
    if (
      !input.enabled ||
      !isOfficialAppearanceAction(request.method, request.path)
    )
      return refuse(
        501,
        "Response font cannot be saved in this read-only Web entry. The previous font is retained.",
      );
    let requestedLocale: string | undefined;
    try {
      if (
        !(request.body instanceof Uint8Array) ||
        request.body.length > 1024 ||
        !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")
      )
        throw Error();
      const body: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(request.body),
      );
      if (localeAction) {
        if (!validLocaleBody(body)) throw Error();
        requestedLocale = body.locale;
      } else if (!validAppearanceBody(body)) {
        throw Error();
      }
    } catch {
      return refuse(
        400,
        "This response font or settings request is unsupported. The previous font is retained.",
      );
    }
    let capability: OfficialAppearanceCapability;
    try {
      const answer = await input.read({
        method: "GET",
        path: officialAppearanceCapabilitiesPath,
      });
      if (!input.current())
        return refuse(
          409,
          "The account activation changed. No appearance change was sent.",
        );
      if (
        answer.status !== 200 ||
        answer.body.length > 8192 ||
        !/^application\/json(?:;|$)/.test(answer.contentType)
      )
        throw Error();
      capability = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(answer.body),
      );
      if (
        capability.version !== 1 ||
        capability.accountId !== input.accountId ||
        typeof capability.activationLease !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          capability.activationLease,
        ) ||
        !Array.isArray(capability.fonts) ||
        JSON.stringify(capability.fonts) !==
          JSON.stringify(officialAppearanceFonts)
      )
        throw Error();
      if (
        requestedLocale !== undefined &&
        (!Array.isArray(capability.locales) ||
          !capability.locales.includes(requestedLocale))
      )
        throw Error();
      if (
        capability.appearance?.state !== "ready" ||
        capability.appearance?.reason !== "ready"
      )
        return refuse(
          501,
          "Response font saving is disabled by this Web host. The previous font is retained.",
        );
    } catch {
      return refuse(
        501,
        "Appearance permission could not be verified. No change was sent.",
      );
    }
    if (!input.current())
      return refuse(
        409,
        "The account activation changed. No appearance change was sent.",
      );
    try {
      const answer = await input.action({
        ...request,
        capabilityLease: capability.activationLease,
      });
      if (!input.current())
        return refuse(
          409,
          "The appearance outcome is unknown after account retirement. Reload settings; the frontend did not resend the change.",
        );
      if (!localeAction)
        report(
          answer.status >= 200 && answer.status < 300
            ? "Response font saved."
            : "The response font save could not be confirmed. Reload settings to check its value; the frontend did not resend the change.",
        );
      return answer;
    } catch {
      return refuse(
        502,
        "The appearance save outcome could not be confirmed. Reload settings before retrying.",
      );
    }
  };
}
