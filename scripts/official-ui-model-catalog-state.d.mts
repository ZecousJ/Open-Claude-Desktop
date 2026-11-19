export const modelCatalogStateRevision: string;
export const modelCatalogStateInputHashes: Record<string, string>;
export const modelCatalogStateOriginalHashes: Record<string, string>;
export const modelCatalogStateRules: Array<{file: string; name: string; before: string; after: string}>;
export function deriveOfficialModelCatalogStateModule(file: string, source: string): string;
export function applyOfficialModelCatalogState(directory: string): {
  revision: string;
  modules: Array<{file: string; originalSha256: string; inputSha256: string; outputSha256: string; rules: string[]}>;
};
