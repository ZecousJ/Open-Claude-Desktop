export const hostIncognitoLifecycleSource: string;
export const hostIncognitoLifecycleRules: readonly { file: string; name: string; before: string; after: string }[];
export const hostIncognitoLifecycleInputHashes: Readonly<Record<string, string>>;
export const hostIncognitoLifecycleOriginalHashes: Readonly<Record<string, string>>;
export function deriveOfficialUiHostIncognitoLifecycleModule(file: string, source: string): string;
export function applyOfficialUiHostIncognitoLifecycle(directory: string): {
  revision: string;
  modules: {
    file: string;
    originalSha256: string;
    inputSha256: string;
    outputSha256: string;
    rules: string[];
  }[];
};
