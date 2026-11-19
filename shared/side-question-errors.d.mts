export type SideQuestionErrorCode = 'attachment' | 'size' | 'history';
export function publicSideQuestionError(error: unknown): string;
export function sideQuestionErrorCode(status: number, response: unknown): SideQuestionErrorCode | undefined;
export function sideQuestionErrorText(error: unknown, intl: { locale?: string; formatMessage(message: { defaultMessage: string; id: string }): string }): string;
