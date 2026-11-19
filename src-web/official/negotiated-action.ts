import { officialDesignArtifactKind } from "../../shared/official-design-artifacts";
import { parseOfficialCapabilityPreferenceRequest } from "../../shared/official-capability-preferences";
import { officialDirectorySubmissionTarget } from "../../shared/official-directory-submissions";
import { officialConnectorAuthTarget } from "../../shared/official-ui-web";
import { parseOfficialConnectorPreference } from "../../shared/official-connector-preferences";
import { parseOfficialModelFallbackRequest } from "../../shared/official-model-fallback";
import { parseOfficialCodeSettingsRequest } from "../../shared/official-code-settings";
import { officialCodeUserSettingsOrganization } from "../../shared/official-code-user-settings";
/** A descriptor identifies the server mode and account activation for this request. */
import {
  officialUiCapabilitiesPath,
  officialCoworkMcpReconciliation,
  officialCoworkCreation,
  officialCoworkDeviceManagement,
  officialMcpAppToolboxTarget,
  isOfficialTextReadiness,
  isOfficialUiChatAction,
  isOfficialUiCompletionSubmission,
  officialUiConversationMutation,
  type OfficialUiCapabilities,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { officialCodePullRequestCreate } from "../../shared/official-code-pull-requests";
import { officialCodePrMonitorOperation } from "../../shared/official-code-pr-monitor";
import { officialCodeFollowupPath, officialCodeUploadOrganization } from "../../shared/official-code-followup";
import { officialCodeConnectorSelection, officialCodeMarkRead, officialCodeMutation, officialCodeSessionCreation } from "../../shared/official-code-history";
import { officialCodeViewerSession } from "../../shared/official-code-viewers";
import { isOfficialCodeTriggerRead, officialCodeTriggerRequest } from "../../shared/official-code-triggers";
import { officialWebReadOnlyAction } from "./readiness";
import type { UploadTransfer } from "../../shared/web-client/codec";
type Call = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
type Action = (request: OfficialUiReadRequest, transfer?: UploadTransfer) => Promise<OfficialUiReadResponse>;
export async function readOfficialCapabilities(
  read: Call,
  accountId: string,
): Promise<OfficialUiCapabilities> {
  const answer = await read({
    method: "GET",
    path: officialUiCapabilitiesPath,
  });
  if (
    answer.status !== 200 ||
    answer.body.byteLength > 8192 ||
    !/^application\/json(?:;|$)/.test(answer.contentType)
  )
    throw Error();
  const capability = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(answer.body),
  );
  if (
    capability.version !== 1 ||
    capability.accountId !== accountId ||
    !["read-only", "strict-text", "engine-chat"].includes(capability.mode) ||
    typeof capability.activationLease !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      capability.activationLease,
    ) ||
    !isOfficialTextReadiness(capability.textChat)
  )
    throw Error();
  return capability;
}
export function officialCapabilityMessage(
  capability: OfficialUiCapabilities,
): string {
  if (capability.mode === "engine-chat")
    return "Ordinary Chat actions use the server's configured Chat engine.";
  const messages = {
    ready:
      "Strict text capability is available; each send still requires current server approval and budget authorization.",
    strict_mode_disabled:
      "The server has not enabled strict text execution. Sending remains blocked.",
    executor_unavailable:
      "A verified strict text executor is not installed. Sending remains blocked.",
    approval_required: "Server approval is required before a new send.",
    budget_unavailable:
      "The shared budget authority is unavailable. New sends remain blocked.",
    tools_unavailable:
      "Tool-free execution is not proven. Sending remains blocked.",
    source_error:
      "Capabilities could not be verified. Sending remains blocked.",
    session_changed: "The account activation changed. Reload before sending.",
  };
  return messages[capability.textChat.reason];
}
export function negotiatedOfficialAction(input: {
  mode: OfficialUiCapabilities["mode"];
  accountId: string;
  isCurrent(): boolean;
  read: Call;
  action: Action;
  onCapabilities?(value: OfficialUiCapabilities | undefined): void;
}): Action {
  const pendingCodeAccountWrites = new Set<Promise<boolean>>();
  const refusal = (status: number, error: string): OfficialUiReadResponse => ({
    status,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify({ error })),
  });
  const perform = async (
    request: OfficialUiReadRequest,
    strict: boolean,
    stop: boolean,
    transfer?: UploadTransfer,
  ) => {
    let capability: OfficialUiCapabilities;
    try {
      capability = await readOfficialCapabilities(input.read, input.accountId);
      if (capability.mode !== input.mode) throw Error();
    } catch {
      if (!input.isCurrent())
        return refusal(409, "The account activation changed.");
      input.onCapabilities?.(undefined);
      return refusal(
        501,
        strict
          ? "Strict text capabilities are unavailable. No send was attempted."
          : "Chat engine capabilities are unavailable. No action was attempted.",
      );
    }
    if (!input.isCurrent())
      return refusal(409, "The account activation changed.");
    input.onCapabilities?.(capability);
    if (
      !(strict && stop) &&
      capability.textChat.state !== "ready"
    )
      return refusal(
        501,
        strict
          ? "Strict text execution is not currently available. No send was attempted."
          : "Chat engine actions are unavailable. No action was attempted.",
      );
    try {
      transfer?.signal.throwIfAborted();
      const answer = await input.action({
        ...request,
        capabilityLease: capability.activationLease,
      }, transfer);
      return input.isCurrent()
        ? answer
        : refusal(
            409,
            "The completion outcome is unknown after account retirement.",
          );
    } catch (error) {
      if (!input.isCurrent())
        return refusal(
          409,
          "The completion outcome is unknown after account retirement.",
        );
      throw error; // No automatic retry after unknown delivery.
    }
  };
  return async (request, transfer) => {
    transfer?.signal.throwIfAborted();
    if (officialDirectorySubmissionTarget(request.method, request.path)?.write) {
      if (!input.isCurrent()) return refusal(409, "The account activation changed.");
      const answer = await input.action(request, transfer);
      return input.isCurrent() ? answer : refusal(409, "The account activation changed.");
    }
    if (input.mode === "read-only") return officialWebReadOnlyAction(request);
    if (!input.isCurrent())
      return refusal(409, "The account activation changed.");
    if (officialDesignArtifactKind(request.method, request.path) === "create") {
      if (input.mode !== "engine-chat") return refusal(501, "Design creation is unavailable on the Web.");
      return perform(request, false, false, transfer);
    }
    const device = officialCoworkDeviceManagement(request.method, request.path);
    const viewer = officialCodeViewerSession(request.method, request.path);
    if ((device && device.method !== "GET") || viewer) {
      const answer = await input.action(request, transfer);
      return input.isCurrent() ? answer : refusal(409, "The account activation changed.");
    }
    const routine = officialCodeTriggerRequest(request.method, request.path);
    if (routine && !isOfficialCodeTriggerRead(routine)) {
      const answer = await input.action(request);
      return input.isCurrent() ? answer : refusal(409, "The account activation changed.");
    }
    let connector, codeSettings, modelFallback, capabilityPreference;
    try {
      connector = parseOfficialConnectorPreference(request);
      codeSettings = !connector && parseOfficialCodeSettingsRequest(request);
      modelFallback = !connector && !codeSettings && parseOfficialModelFallbackRequest(request);
      capabilityPreference = !connector && !codeSettings && !modelFallback && parseOfficialCapabilityPreferenceRequest(request);
    } catch (error) {
      return refusal(400, error instanceof Error ? error.message : "Invalid settings request.");
    }
    const completion = isOfficialUiCompletionSubmission(
        request.method,
        request.path,
      ),
      stop =
        officialUiConversationMutation(request.method, request.path) === "stop";
    const strict = input.mode === "strict-text";
    const codeCreation = officialCodeSessionCreation(request.method, request.path);
    const codeAction = modelFallback || capabilityPreference || codeSettings || codeCreation ||
      (request.method === "PUT" && officialCodeUserSettingsOrganization(request.path)) ||
      officialCoworkCreation(request.method, request.path) ||
      officialMcpAppToolboxTarget(request.method, request.path) ||
      officialCoworkMcpReconciliation(request.method, request.path) ||
      officialCodeFollowupPath(request.method, request.path) ||
      officialCodeUploadOrganization(request.method, request.path) ||
      officialCodeConnectorSelection(request.method, request.path) ||
      officialCodeMarkRead(request.method, request.path) ||
      officialCodeMutation(request.method, request.path) ||
      officialCodePullRequestCreate(request.method, request.path) ||
      officialCodePrMonitorOperation(request.method, request.path);
    if (strict ? !completion && !stop : !connector && !codeAction && !officialConnectorAuthTarget(request.method, request.path) && !isOfficialUiChatAction(request.method, request.path))
      return refusal(
        501,
        strict
          ? "Only negotiated strict text submission and owned Stop are supported."
          : "This Chat action is unavailable on the Web.",
      );
    if (codeCreation && pendingCodeAccountWrites.size) {
      const saved = await Promise.all(pendingCodeAccountWrites);
      if (saved.includes(false))
        return refusal(409, "Account settings could not be saved. Retry the settings change before starting Code.");
      if (!input.isCurrent()) return refusal(409, "The account activation changed.");
    }
    if (connector?.kind !== "account" && !codeSettings) return perform(request, strict, stop, transfer);
    const result = perform(request, strict, stop, transfer);
    const saved = result.then((answer) => answer.status >= 200 && answer.status < 300, () => false);
    pendingCodeAccountWrites.add(saved);
    void saved.then(() => pendingCodeAccountWrites.delete(saved));
    return result;
  };
}
