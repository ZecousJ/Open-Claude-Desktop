/**
 * CLAUDEX: the public desktop checkout endpoint (B10; backend
 * internal/claudex/payment). The Claudex desktop app opens
 * /desktop-pay#t=<token> in the system browser for Stripe/Airwallex orders;
 * the page trades the token for what it needs to show the payment form.
 *
 * This module uses fetch only, never the shared axios client: that client
 * attaches the web console's sign-in token and sends a 401 to /login, and the
 * checkout page must work without any sign-in or stored browser state.
 */

import { buildApiUrl } from './url'

/** Name of the URL fragment parameter that carries the checkout token. */
export const CHECKOUT_TOKEN_PARAM = 't'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type DesktopCheckoutProvider = 'stripe' | 'airwallex'

export interface DesktopCheckoutStripe {
  publishable_key: string
  client_secret: string
}

export interface DesktopCheckoutAirwallex {
  env: string
  intent_id: string
  client_secret: string
  currency: string
  country_code: string
}

/** POST /api/v1/claudex/payment/checkout. stripe/airwallex are set only while the order can be paid. */
export interface DesktopCheckout {
  order_id: number
  status: string
  provider: DesktopCheckoutProvider
  amount: number
  pay_amount: number
  currency: string
  expires_at: string
  stripe: DesktopCheckoutStripe | null
  airwallex: DesktopCheckoutAirwallex | null
  result_path: string
}

export class DesktopCheckoutError extends Error {
  /** HTTP status; 0 when the request never got an answer. */
  readonly status: number
  /** Server reason code, e.g. CLAUDEX_CHECKOUT_NOT_FOUND. */
  readonly reason: string

  constructor(status: number, reason: string, message: string) {
    super(message || `Checkout request failed (${status})`)
    this.name = 'DesktopCheckoutError'
    this.status = status
    this.reason = reason
  }
}

/** Reads the checkout token from a URL fragment such as "#t=<token>"; '' when absent or malformed. */
export function readCheckoutToken(hash: string): string {
  const raw = (hash || '').replace(/^#/, '')
  if (!raw) return ''
  const token = new URLSearchParams(raw).get(CHECKOUT_TOKEN_PARAM) || ''
  return TOKEN_PATTERN.test(token) ? token : ''
}

/**
 * The server's result_path when it is the upstream public result page on this
 * site (/payment/result?...), otherwise ''. Guards the redirect after paying.
 */
export function safeResultPath(path: unknown): string {
  if (typeof path !== 'string') return ''
  if (!path.startsWith('/payment/result') || path.startsWith('//')) return ''
  const rest = path.slice('/payment/result'.length)
  return rest === '' || rest.startsWith('?') ? path : ''
}

interface Envelope {
  code?: number
  message?: string
  reason?: string
  data?: unknown
}

export async function fetchDesktopCheckout(token: string, options: { signal?: AbortSignal } = {}): Promise<DesktopCheckout> {
  let res: Response
  try {
    res = await fetch(buildApiUrl('/claudex/payment/checkout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: options.signal
    })
  } catch (err) {
    throw new DesktopCheckoutError(0, 'NETWORK_ERROR', err instanceof Error ? err.message : '')
  }
  let body: Envelope | null = null
  try {
    body = (await res.json()) as Envelope
  } catch {
    body = null
  }
  if (!res.ok || !body || body.code !== 0 || !body.data || typeof body.data !== 'object') {
    throw new DesktopCheckoutError(res.status || 0, body?.reason || '', body?.message || '')
  }
  return body.data as DesktopCheckout
}

export const claudexCheckoutAPI = {
  fetchDesktopCheckout,
  readCheckoutToken,
  safeResultPath
}

export default claudexCheckoutAPI
