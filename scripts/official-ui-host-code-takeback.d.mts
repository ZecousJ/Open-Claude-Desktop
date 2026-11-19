export const hostCodeTakebackRevision: string;
export const hostCodeTakebackTarget: string;
export const hostCodeTakebackInputHashes: Record<string, string>;
export const hostCodeTakebackOriginalHashes: Record<string, string>;
export const hostCodeTakebackHelper: string;
export const hostCodeTakebackRules: Array<{
  file: string;
  name: string;
  before: string;
  after: string;
}>;
export function deriveOfficialUiHostCodeTakebackModule(
  file: string,
  source: string,
): string;
export function applyOfficialUiHostCodeTakeback(directory: string): {
  revision: string;
  modules: Array<{
    file: string;
    originalSha256: string;
    inputSha256: string;
    outputSha256: string;
    rules: string[];
  }>;
};
