/**
 * CLAUDEX: error messages for the Claudex console pages.
 *
 * Claudex admin endpoints answer errors as {code, message, reason, metadata}
 * with reason CLAUDEX_*. A page shows its own text from
 * admin.<page>.errors.<REASON> (for example admin.claudexPolicy.errors.
 * CLAUDEX_POLICY_REVISION_CONFLICT), then the shared admin.claudex.errors.
 * <REASON>, and otherwise the server's message.
 */

import { extractApiErrorCode, extractApiErrorMessage } from '@/utils/apiError'

type Translate = (key: string, params?: Record<string, unknown>) => string
type TranslateExists = (key: string) => boolean

/** The CLAUDEX_* reason of an API error, if it has one. */
export function claudexErrorReason(err: unknown): string | undefined {
  const code = extractApiErrorCode(err)
  return code && code.startsWith('CLAUDEX_') ? code : undefined
}

/**
 * The message to show for an error from a Claudex console page. `page` is
 * the page's locale module (e.g. 'claudexPolicy'); `fallback` is used when
 * the error carries no message at all.
 */
export function claudexErrorMessage(
  err: unknown,
  t: Translate,
  te: TranslateExists,
  page: string | null,
  fallback: string
): string {
  const reason = claudexErrorReason(err)
  if (reason) {
    const keys = [page ? `admin.${page}.errors.${reason}` : '', `admin.claudex.errors.${reason}`]
    for (const key of keys) {
      if (key && te(key)) return t(key)
    }
  }
  return extractApiErrorMessage(err, fallback)
}
