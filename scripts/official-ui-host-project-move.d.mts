export const hostProjectMoveRevision: string;
export const hostProjectMoveInputHashes: Readonly<Record<string, string>>;
export const hostProjectMoveOriginalHashes: Readonly<Record<string, string>>;
export const hostProjectMoveRules: readonly { file: string; name: string; before: string; after: string }[];
export function deriveOfficialUiHostProjectMoveModule(file: string, source: string): string;
export function applyOfficialUiHostProjectMove(directory: string): { revision: string; modules: { file: string; originalSha256: string; inputSha256: string; outputSha256: string; rules: string[] }[] };
