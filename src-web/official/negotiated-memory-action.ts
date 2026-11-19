import { officialMemoryAction, officialMemoryCapabilitiesPath, officialMemorySettingsPreference, parseOfficialMemorySettings, type OfficialMemoryCapability } from "../../shared/official-memory-capability";
import type { OfficialUiReadRequest, OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { UploadTransfer } from "../../shared/web-client/codec";

type Call = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
type Action = (request: OfficialUiReadRequest, transfer?: UploadTransfer) => Promise<OfficialUiReadResponse>;
const refuse = (status: number, message: string): OfficialUiReadResponse => ({
  status, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ error: { message } })),
});

export function negotiatedMemoryAction(input: {
  enabled: boolean;
  accountId: string;
  current(): boolean;
  read: Call;
  action: Action;
  onStatus?(message: string): void;
}): Action {
  return async (request, transfer) => {
    const operation = officialMemoryAction(request.method, request.path);
    if (!operation || operation === "controls" && !input.enabled)
      return refuse(501, "This memory operation is unavailable on this Web host.");
    if (!input.current()) return refuse(409, "The account activation changed.");
    transfer?.signal.throwIfAborted();
    const settings = operation === "settings" ? (() => {
      try {
        if (request.body instanceof Uint8Array)
          return parseOfficialMemorySettings(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
      } catch {
        return undefined;
      }
    })() : undefined;
    if (operation === "settings" && !settings) return refuse(400, "Invalid memory settings.");
    let capability: OfficialMemoryCapability;
    try {
      const answer = await input.read({ method: "GET", path: officialMemoryCapabilitiesPath });
      if (!input.current()) return refuse(409, "The account activation changed.");
      if (answer.status !== 200 || answer.body.byteLength > 8192 || !/^application\/json(?:;|$)/.test(answer.contentType))
        throw Error();
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(answer.body));
      if (value.version !== 1 || value.accountId !== input.accountId || typeof value.activationLease !== "string" ||
          !value.activationLease || value.activationLease.length > 128 || value.generation !== "unavailable" ||
          (value.synthesis !== undefined && value.synthesis !== "ready") ||
          !["ready", "unavailable"].includes(value.reset) || !["disable-only", "unavailable"].includes(value.settings) ||
          (value.preferences !== undefined && (typeof value.preferences?.generate !== "boolean" ||
            typeof value.preferences?.searchChats !== "boolean")) ||
          !value.controls) throw Error();
      capability = value;
    } catch {
      if (input.current()) input.onStatus?.("Memory controls could not be verified. No changes were sent.");
      return refuse(501, "The memory capability could not be verified.");
    }
    if (!input.current()) return refuse(409, "The account activation changed.");
    transfer?.signal.throwIfAborted();
    const preference = settings && officialMemorySettingsPreference(settings);
    const ready = {
      controls: capability.controls.state === "ready" && capability.controls.reason === "ready",
      synthesize: capability.synthesis === "ready",
      reset: capability.reset === "ready",
      settings: preference?.key === "generate" && !preference.enabled
        ? capability.settings === "disable-only"
        : !!preference && capability.preferences?.[preference.key] === true,
      backfill: capability.preferences?.searchChats === true,
    }[operation];
    if (!ready) {
      if (operation === "controls") input.onStatus?.("Manual memory controls are unavailable.");
      return refuse(501, "This memory operation is currently unavailable.");
    }
    if (operation === "controls")
      input.onStatus?.("Only manual memory rules can be saved. This does not enable generation or request a model; existing authorized background tasks are unchanged.");
    if (!input.current()) return refuse(409, "The account activation changed.");
    const retired = () => refuse(409, "The account changed. Reload memory to check the result.");
    try {
      const answer = await input.action({ ...request, capabilityLease: capability.activationLease }, transfer);
      return input.current() ? answer : retired();
    } catch (error) {
      if (!input.current()) return retired();
      throw error;
    }
  };
}
