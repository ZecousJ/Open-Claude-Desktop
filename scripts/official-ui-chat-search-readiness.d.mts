interface SearchReadinessManifest {
  revision: string;
  modules: { file: string; inputSha256: string; outputSha256: string }[];
}

export const chatSearchReadinessRevision: string;
export const chatSearchReadinessTarget: string;
export const chatSearchReadinessInput: string;
export const chatSearchReadinessOutput: string;
export const chatSearchReadinessRule: { before: string; after: string };
export function deriveOfficialChatSearchReadinessModule(file: string, source: string): string;
export function applyOfficialChatSearchReadiness(directory: string): SearchReadinessManifest;
export function verifyOfficialChatSearchReadinessManifest(
  manifest: unknown,
  files: readonly { path: string; sha256: string }[],
  outputSha256: string,
): void;
