import { branchPrefixProblem } from "./branch-prefix";
import {
  preference,
  preferenceDefaults,
  type SettingsPreferences,
} from "./settings-extras";
import type { OfficialUiReadRequest } from "./official-ui-web";

export type CodeSettingsPatch = Pick<
  SettingsPreferences,
  "codeBranchPrefix" | "prAutoArchive" | "prAutoCreate" | "prAutoCreateDraft" | "prAutoFix"
>;
export const officialCodeSettingsPath = "/api/claudex/code-settings";
const pullRequestSettings = [
  ["ccr_auto_archive_on_pr_close", "prAutoArchive"],
  ["ccr_auto_create_pr_on_push", "prAutoCreate"],
  ["ccr_auto_create_pr_as_draft", "prAutoCreateDraft"],
  ["ccr_autofix_on_pr_create", "prAutoFix"],
] as const;

export function savedCodeSettings(
  settings: SettingsPreferences,
): CodeSettingsPatch {
  const { codeBranchPrefix } = settings;
  return {
    ...(typeof codeBranchPrefix === "string" &&
    branchPrefixProblem(codeBranchPrefix) === null
      ? {
          codeBranchPrefix:
            codeBranchPrefix || preferenceDefaults.codeBranchPrefix,
        }
      : {}),
    ...Object.fromEntries(pullRequestSettings.flatMap(([, key]) =>
      typeof settings[key] === "boolean" ? [[key, settings[key]]] : [],
    )),
  };
}

export function codeSettingsWire(patch: CodeSettingsPatch) {
  return {
    ...(patch.codeBranchPrefix !== undefined
      ? { ccr_branch_prefix: patch.codeBranchPrefix }
      : {}),
    ...Object.fromEntries(pullRequestSettings.flatMap(([wire, key]) =>
      patch[key] === undefined ? [] : [[wire, patch[key]]],
    )),
  };
}

export function officialCodeSettings(settings: SettingsPreferences) {
  const prefix = preference(settings, "codeBranchPrefix");
  return {
    ccr_branch_prefix:
      prefix && branchPrefixProblem(prefix) === null
        ? prefix
        : preferenceDefaults.codeBranchPrefix,
    ccr_auto_archive_on_pr_close: preference(settings, "prAutoArchive"),
    ccr_auto_create_pr_on_push: preference(settings, "prAutoCreate"),
    ccr_auto_create_pr_as_draft: settings.prAutoCreateDraft ?? true,
    ccr_autofix_on_pr_create: preference(settings, "prAutoFix"),
  };
}

export function parseOfficialCodeSettings(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const hasPrefix = "ccr_branch_prefix" in body;
  const toggles = pullRequestSettings.filter(([wire]) => wire in body);
  if (!hasPrefix && toggles.length === 0) return undefined;
  if (Object.keys(body).length !== Number(hasPrefix) + toggles.length)
    throw Error("Update Code settings separately from other account settings.");

  const patch: CodeSettingsPatch = {};
  if (hasPrefix) {
    const prefix =
      typeof body.ccr_branch_prefix === "string"
        ? body.ccr_branch_prefix.trim()
        : undefined;
    if (prefix === undefined || branchPrefixProblem(prefix))
      throw Error("Choose a valid branch prefix.");
    patch.codeBranchPrefix =
      prefix || preferenceDefaults.codeBranchPrefix;
  }
  for (const [wire, key] of toggles) {
    const enabled = Object.getOwnPropertyDescriptor(body, wire)?.value;
    if (typeof enabled !== "boolean")
      throw Error("Choose whether to enable this pull request setting.");
    patch[key] = enabled;
  }
  return { patch, wire: codeSettingsWire(patch) };
}

export function parseOfficialCodeSettingsRequest(
  request: OfficialUiReadRequest,
) {
  if (
    request.method !== "PATCH" ||
    request.path !== "/api/account/settings" ||
    !(request.body instanceof Uint8Array) ||
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")
  )
    return undefined;
  return parseOfficialCodeSettings(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)),
  );
}
