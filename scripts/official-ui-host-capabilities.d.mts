export const hostCapabilityOriginalHashes: Readonly<Record<string, string>>;
export const hostCapabilityRules: readonly { file: string; name: string; before: string; after: string }[];
export function deriveOfficialUiHostCapabilityModule(file: string, source: string): string;
