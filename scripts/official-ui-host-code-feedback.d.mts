export const hostCodeFeedbackInputHashes: Readonly<Record<string, string>>;
export const hostCodeFeedbackOriginalHashes: Readonly<Record<string, string>>;
export const hostCodeFeedbackHelper: string;
export const hostCodeFeedbackRules: readonly { file: string; name: string; before: string; after: string }[];
export function deriveOfficialUiHostCodeFeedbackModule(file: string, source: string): string;
