/**
 * CLAUDEX: shared checks for the Claudex console forms. The server validates
 * again and is authoritative; these only catch mistakes before saving.
 */

/** Longest URL the Claudex settings accept (core.HTTPSURL on the server). */
export const CLAUDEX_URL_MAX_LENGTH = 2000

export type UrlProblem = 'required' | 'https' | 'tooLong'

/**
 * Checks an https URL field. An empty value is fine unless `required`.
 * Returns null when the value is acceptable.
 */
export function validateHttpsUrl(
  value: string | null | undefined,
  options: { required?: boolean; maxLength?: number } = {}
): UrlProblem | null {
  const text = (value ?? '').trim()
  if (!text) return options.required ? 'required' : null
  if (text.length > (options.maxLength ?? CLAUDEX_URL_MAX_LENGTH)) return 'tooLong'
  if (/\s/.test(text)) return 'https'
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'https'
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return 'https'
  return null
}

/** i18n key of the message for a URL problem. */
export function urlProblemMessageKey(problem: UrlProblem): string {
  switch (problem) {
    case 'required':
      return 'admin.claudex.common.required'
    case 'tooLong':
      return 'admin.claudex.common.urlTooLong'
    default:
      return 'admin.claudex.common.https'
  }
}
