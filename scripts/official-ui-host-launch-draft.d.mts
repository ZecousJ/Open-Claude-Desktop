export const hostLaunchDraftRevision: string;
export const hostLaunchDraftInputHashes: Readonly<Record<string, string>>;
export const hostLaunchDraftOriginalHashes: Readonly<Record<string, string>>;
export const hostLaunchDraftRules: readonly {
  file: string;
  name: string;
  before: string;
  after: string;
}[];
export function deriveOfficialUiLaunchDraftModule(file: string, source: string): string;
export function applyOfficialUiHostLaunchDraft(directory: string): {
  revision: string;
  modules: {
    file: string;
    originalSha256: string;
    inputSha256: string;
    outputSha256: string;
    rules: string[];
  }[];
};
