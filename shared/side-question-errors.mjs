/** Presentation-only mapping: never display arbitrary server or provider text. */
const sideQuestionKnown = new Map([
  ['A side-question attachment is unavailable or changed.', 'attachment'],
  ['A side-question attachment changed.', 'attachment'],
  ['The side-question attachment changed.', 'attachment'],
  ['The side-question attachments are unavailable.', 'attachment'],
  ['The side-question attachments are too large.', 'size'],
  ['The side-question text attachment is too large.', 'size'],
  ['The side-question history is too large.', 'size'],
  ['The side-question context is too large.', 'size'],
  ['The side-question edit history is too large.', 'size'],
  ['The side-question history is unavailable.', 'history'],
  ['The side-question history is not yet available.', 'history'],
  ['The side-question edit history is unavailable.', 'history'],
  ['The side-question tool history is incomplete.', 'history'],
  ['The side-question tool history is unsupported or incomplete.', 'history'],
  ['This side-question history contains unsupported content.', 'history'],
  ['This side-question history is unavailable.', 'history'],
  ['This side-question diff history is unsupported or too large.', 'history'],
]);
const safeDetails = new Set([
  ...sideQuestionKnown.keys(),
  'The account activation changed.',
  'The side-question account changed.',
  'The side-question instructions are unavailable.',
  'The side-question source changed. Try again.',
  'The side-question parent is ambiguous.',
  'The side-question parent is not in this conversation.',
  'The side-question attachment identity is ambiguous.',
  'The side-question attachment is invalid.',
  'The side-question image type is unsupported.',
  'The side-question message is empty.',
  'This conversation cannot be used for a side question.',
]);
/** Only fixed, non-sensitive failures may cross the HTTP boundary. */
export function publicSideQuestionError(error) {
  try {
    const message = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
    if (safeDetails.has(message)) return message;
  } catch {}
  return 'The side question could not be started.';
}
export function sideQuestionErrorCode(status, response) {
  if (status !== 409 || !response || typeof response !== 'object' ||
      response.type !== 'error' || !response.error ||
      response.error.type !== 'invalid_request_error' ||
      typeof response.error.message !== 'string') return undefined;
  return sideQuestionKnown.get(response.error.message);
}
export function sideQuestionErrorText(error, intl) {
  const zh = typeof intl?.locale === 'string' && /^zh(?:-|$)/i.test(intl.locale);
  switch (error?.claudexSideQuestionCode) {
    case 'attachment':
      return zh ? '此会话中的文件不可用或已变化。请在新会话中重新添加文件后提问。' : 'A file in this conversation is unavailable or has changed. Start a new conversation with the file and try again.';
    case 'size':
      return zh ? '此会话的内容或文件过大，无法用于侧问。请在新会话中提供相关内容。' : 'This conversation or its files are too large for a side question. Start a new conversation with the relevant context.';
    case 'history':
      return zh ? '此会话的部分历史无法用于侧问。请在新会话中提供相关内容。' : 'Some conversation history cannot be used for a side question. Start a new conversation with the relevant context.';
    default:
      return intl.formatMessage({ defaultMessage: 'Something went wrong', id: 'JqiqNj0Ooi' });
  }
}
