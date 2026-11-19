import type { OfficialUiReadRequest } from "./official-ui-web";

export const officialModelFallbackPath = "/api/account/settings";
export type ModelFallbackPatch =
  | { kind: "model"; enabled: boolean; resetCode: boolean }
  | { kind: "code"; enabled: boolean; companion: boolean; toolSearchCompanion?: "on" | "off" };

export function parseOfficialModelFallback(body: unknown): ModelFallbackPatch | undefined {
  if (!body || typeof body !== "object" || !Object.hasOwn(body, "enabled_model_auto_fallback"))
    return undefined;
  if (!("enabled_model_auto_fallback" in body) || typeof body.enabled_model_auto_fallback !== "boolean" ||
      Object.keys(body).some(key => key !== "enabled_model_auto_fallback" && key !== "ccr_switch_models_on_flag" && key !== "tool_search_mode"))
    throw Error("Invalid model fallback settings.");
  const fallback = body.enabled_model_auto_fallback;
  if ("tool_search_mode" in body && (!("ccr_switch_models_on_flag" in body) ||
      typeof body.ccr_switch_models_on_flag !== "boolean" ||
      (body.tool_search_mode !== "on" && body.tool_search_mode !== "off")))
    throw Error("Invalid tool access mode companion.");
  if (!("ccr_switch_models_on_flag" in body))
    return { kind: "model", enabled: fallback, resetCode: false };
  if (body.ccr_switch_models_on_flag === null)
    return { kind: "model", enabled: fallback, resetCode: true };
  if (typeof body.ccr_switch_models_on_flag === "boolean")
    return { kind: "code", enabled: body.ccr_switch_models_on_flag, companion: fallback,
      ...("tool_search_mode" in body && (body.tool_search_mode === "on" || body.tool_search_mode === "off")
        ? { toolSearchCompanion: body.tool_search_mode } : {}) };
  throw Error("Invalid Code model switching setting.");
}

export function parseOfficialModelFallbackRequest(request: OfficialUiReadRequest) {
  if (request.method !== "PATCH" || request.path !== officialModelFallbackPath ||
      !(request.body instanceof Uint8Array) ||
      !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")) return undefined;
  return parseOfficialModelFallback(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
}

export function modelFallbackSettings(change: ModelFallbackPatch) {
  return change.kind === "code"
    ? { switchModelsOnFlag: change.enabled }
    : {
        modelAutoFallback: change.enabled,
        ...(change.resetCode ? { switchModelsOnFlag: undefined } : {}),
      };
}

export function modelFallbackWire(change: ModelFallbackPatch) {
  return change.kind === "code"
    ? { ccr_switch_models_on_flag: change.enabled }
    : {
        enabled_model_auto_fallback: change.enabled,
        ...(change.resetCode ? { ccr_switch_models_on_flag: null } : {}),
      };
}
