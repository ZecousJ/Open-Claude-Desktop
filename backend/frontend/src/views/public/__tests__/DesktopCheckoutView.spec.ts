// CLAUDEX: tests for /desktop-pay, the public checkout page the Claudex desktop
// app opens in the browser for Stripe/Airwallex orders (B10). The page must
// work with no sign-in and no browser storage, talk only to the public
// checkout endpoint (never the JWT /api/v1/payment/* API) and drop the token
// from the address bar.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DesktopCheckoutView from '@/views/public/DesktopCheckoutView.vue'
import { readCheckoutToken, safeResultPath } from '@/api/claudexCheckout'
import { claudexPublicRoutes } from '@/router/claudex'
import { resolveAdminOnlyPublicRedirect } from '@/router/webConsole'

const TOKEN = 'q2hT6yM0y1dQ3zR2kq5vY8nX4bP7cW9eL0aJ2sD4fG6'
const RESUME = 'eyJvaWQiOjEwMjR9.sig'
const RESULT_PATH = `/payment/result?resume_token=${encodeURIComponent(RESUME)}`

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  loadStripe: vi.fn(),
  airwallexInit: vi.fn()
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: mocks.replace })
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    locale: { value: 'en' }
  })
}))

vi.mock('@stripe/stripe-js/pure', () => ({
  loadStripe: (...args: unknown[]) => mocks.loadStripe(...args)
}))

vi.mock('@airwallex/components-sdk', () => ({
  init: (...args: unknown[]) => mocks.airwallexInit(...args)
}))

interface FetchCall {
  url: string
  init: RequestInit
}

let fetchCalls: FetchCall[] = []
let fetchReplies: Array<{ status: number; body: unknown } | Error> = []
let xhrOpened: string[] = []
let storageTouches = 0
const savedStorage = new Map<string, PropertyDescriptor | undefined>()

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 1024,
    status: 'PENDING',
    provider: 'stripe',
    amount: 20,
    pay_amount: 20.6,
    currency: 'USD',
    expires_at: '2026-09-26T03:00:00Z',
    stripe: { publishable_key: 'pk_test_51Q', client_secret: 'pi_3Q_secret_abc' },
    airwallex: null,
    result_path: RESULT_PATH,
    ...overrides
  }
}

function reply(status: number, body: unknown) {
  fetchReplies.push({ status, body })
}

function ok(data: unknown) {
  reply(200, { code: 0, message: 'success', data })
}

function stripeStub(options: { confirm?: () => Promise<unknown> } = {}) {
  const element = {
    mount: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'ready') cb()
    })
  }
  const elements = { create: vi.fn(() => element) }
  const stripe = {
    elements: vi.fn(() => elements),
    confirmPayment: vi.fn(options.confirm ?? (async () => ({ paymentIntent: { status: 'succeeded' } })))
  }
  mocks.loadStripe.mockResolvedValue(stripe)
  return { stripe, elements, element }
}

function openAt(url: string) {
  window.history.replaceState(null, '', url)
}

function blockStorage() {
  for (const name of ['localStorage', 'sessionStorage']) {
    for (const target of new Set<object>([window, globalThis])) {
      savedStorage.set(`${target === window ? 'w' : 'g'}:${name}`, Object.getOwnPropertyDescriptor(target, name))
      Object.defineProperty(target, name, {
        configurable: true,
        get() {
          storageTouches++
          throw new DOMException('Storage is disabled', 'SecurityError')
        }
      })
    }
  }
}

function restoreStorage() {
  for (const [key, desc] of savedStorage) {
    const [where, name] = key.split(':')
    const target = where === 'w' ? window : globalThis
    if (desc) Object.defineProperty(target, name, desc)
    else delete (target as Record<string, unknown>)[name]
  }
  savedStorage.clear()
}

function mountPage() {
  return mount(DesktopCheckoutView, {
    attachTo: document.body,
    global: {
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to" data-router-link><slot /></a>' }
      }
    }
  })
}

async function settle() {
  for (let i = 0; i < 6; i++) await flushPromises()
}

beforeEach(() => {
  fetchCalls = []
  fetchReplies = []
  xhrOpened = []
  storageTouches = 0
  mocks.replace.mockReset()
  mocks.loadStripe.mockReset()
  mocks.airwallexInit.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    const next = fetchReplies.shift()
    if (!next) throw new Error(`unexpected fetch ${url}`)
    if (next instanceof Error) throw next
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body
    } as Response
  }))
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(function (this: XMLHttpRequest, _method: string, url: string | URL) {
    xhrOpened.push(String(url))
  } as typeof XMLHttpRequest.prototype.open)
  blockStorage()
})

afterEach(() => {
  restoreStorage()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.innerHTML = ''
  openAt('/')
})

function expectOnlyPublicCheckoutRequests() {
  expect(xhrOpened).toEqual([])
  for (const call of fetchCalls) {
    expect(call.url).toMatch(/\/api\/v1\/claudex\/payment\/checkout$/)
    expect(call.url).not.toContain('/api/v1/payment/')
    expect(call.url).not.toContain(TOKEN)
    const headers = new Headers(call.init.headers)
    expect(headers.has('Authorization')).toBe(false)
    expect(call.init.credentials).toBe('omit')
  }
  expect(storageTouches).toBe(0)
}

describe('DesktopCheckoutView', () => {
  it('clears the fragment, loads the order without sign-in or storage and mounts the Stripe Payment Element', async () => {
    const { stripe, elements, element } = stripeStub()
    ok(checkout())
    openAt(`/desktop-pay#t=${TOKEN}`)

    const wrapper = mountPage()
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(window.location.pathname).toBe('/desktop-pay')
    await settle()

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].init.method).toBe('POST')
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({ token: TOKEN })
    expect(mocks.loadStripe).toHaveBeenCalledWith('pk_test_51Q')
    expect(stripe.elements).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: 'pi_3Q_secret_abc' }))
    expect(elements.create).toHaveBeenCalledWith('payment', expect.objectContaining({ layout: 'tabs' }))
    const host = element.mount.mock.calls[0][0] as HTMLElement
    expect(host.id).toBe('desktop-checkout-stripe-element')
    expect(wrapper.get('[data-testid="desktop-checkout-order"]').text()).toContain('"id":1024')
    expect(wrapper.get('[data-testid="desktop-checkout-amount"]').text()).toContain('20.60')
    const pay = wrapper.get('[data-testid="desktop-checkout-pay"]')
    expect(pay.attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).not.toContain('pi_3Q_secret_abc')
    expectOnlyPublicCheckoutRequests()
    wrapper.unmount()
    expect(element.destroy).toHaveBeenCalled()
  })

  it('pays with Stripe and then opens the public result page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { stripe } = stripeStub()
    ok(checkout())
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()

    await wrapper.get('[data-testid="desktop-checkout-pay"]').trigger('click')
    await settle()
    expect(stripe.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect: 'if_required',
        confirmParams: { return_url: `${window.location.origin}${RESULT_PATH}` }
      })
    )
    expect(wrapper.find('[data-testid="desktop-checkout-succeeded"]').exists()).toBe(true)
    expect(mocks.replace).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(mocks.replace).toHaveBeenCalledWith(RESULT_PATH)
    expectOnlyPublicCheckoutRequests()
  })

  it('shows a declined payment and lets the user try again', async () => {
    const { stripe } = stripeStub({ confirm: async () => ({ error: { message: 'Your card was declined.' } }) })
    ok(checkout())
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()

    await wrapper.get('[data-testid="desktop-checkout-pay"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-error"]').text()).toBe('Your card was declined.')
    expect(wrapper.get('[data-testid="desktop-checkout-pay"]').attributes('disabled')).toBeUndefined()
    expect(mocks.replace).not.toHaveBeenCalled()

    stripe.confirmPayment.mockRejectedValueOnce(new Error('network'))
    await wrapper.get('[data-testid="desktop-checkout-pay"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-error"]').text()).toBe('desktopCheckout.paymentFailed')
  })

  it('opens the Airwallex checkout with the order data', async () => {
    const redirectToCheckout = vi.fn()
    mocks.airwallexInit.mockResolvedValue({ payments: { redirectToCheckout } })
    ok(
      checkout({
        provider: 'airwallex',
        currency: 'HKD',
        stripe: null,
        airwallex: { env: 'prod', intent_id: 'int_hk', client_secret: 'awx_cs', currency: 'HKD', country_code: 'HK' }
      })
    )
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()

    expect(mocks.airwallexInit).toHaveBeenCalledWith({ env: 'prod', enabledElements: ['payments'], locale: 'en' })
    expect(redirectToCheckout).toHaveBeenCalledWith({
      intent_id: 'int_hk',
      client_secret: 'awx_cs',
      currency: 'HKD',
      country_code: 'HK',
      successUrl: `${window.location.origin}${RESULT_PATH}`
    })
    expect(wrapper.find('[data-testid="desktop-checkout-airwallex"]').exists()).toBe(true)
    expect(mocks.loadStripe).not.toHaveBeenCalled()
    expectOnlyPublicCheckoutRequests()
  })

  it('falls back to the demo environment and the upstream defaults for Airwallex', async () => {
    const redirectToCheckout = vi.fn()
    mocks.airwallexInit.mockResolvedValue({ payments: { redirectToCheckout } })
    ok(
      checkout({
        provider: 'airwallex',
        stripe: null,
        airwallex: { env: 'demo', intent_id: 'int_x', client_secret: 'cs_x', currency: '', country_code: '' }
      })
    )
    openAt(`/desktop-pay#t=${TOKEN}`)
    mountPage()
    await settle()
    expect(mocks.airwallexInit).toHaveBeenCalledWith(expect.objectContaining({ env: 'demo' }))
    expect(redirectToCheckout).toHaveBeenCalledWith(expect.objectContaining({ currency: 'CNY', country_code: 'CN' }))
  })

  it('says so when the Airwallex SDK has no payments element', async () => {
    mocks.airwallexInit.mockResolvedValue({})
    ok(checkout({ provider: 'airwallex', stripe: null, airwallex: { env: 'prod', intent_id: 'i', client_secret: 'c', currency: 'USD', country_code: 'US' } }))
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('airwallexLoadFailed')
  })

  it('says so when Stripe cannot load and retries in place, since a reload would lose the token', async () => {
    mocks.loadStripe.mockResolvedValue(null)
    ok(checkout())
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('stripeLoadFailed')
    expect(wrapper.findAll('iframe, form, input')).toHaveLength(0)
    expect(window.location.hash).toBe('')

    const { element } = stripeStub()
    ok(checkout())
    await wrapper.get('[data-testid="desktop-checkout-retry"]').trigger('click')
    await settle()
    expect(fetchCalls).toHaveLength(2)
    expect(JSON.parse(String(fetchCalls[1].init.body))).toEqual({ token: TOKEN })
    expect(element.mount).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="desktop-checkout-pay"]').attributes('disabled')).toBeUndefined()
    expectOnlyPublicCheckoutRequests()
  })

  it('retries the Airwallex checkout in place after the SDK failed', async () => {
    const awx = { env: 'prod', intent_id: 'int_1', client_secret: 'c', currency: 'USD', country_code: 'US' }
    mocks.airwallexInit.mockRejectedValueOnce(new Error('script blocked'))
    ok(checkout({ provider: 'airwallex', stripe: null, airwallex: awx }))
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('airwallexLoadFailed')

    const redirectToCheckout = vi.fn()
    mocks.airwallexInit.mockResolvedValue({ payments: { redirectToCheckout } })
    ok(checkout({ provider: 'airwallex', stripe: null, airwallex: awx }))
    await wrapper.get('[data-testid="desktop-checkout-retry"]').trigger('click')
    await settle()
    expect(redirectToCheckout).toHaveBeenCalledTimes(1)
    expect(redirectToCheckout).toHaveBeenCalledWith(expect.objectContaining({ intent_id: 'int_1', client_secret: 'c' }))
    expectOnlyPublicCheckoutRequests()
  })

  it.each([
    ['COMPLETED', 'paid', true],
    ['PAID', 'paid', true],
    ['RECHARGING', 'paid', true],
    ['EXPIRED', 'expired', false],
    ['CANCELLED', 'closed', true],
    ['FAILED', 'closed', true],
    ['REFUNDED', 'closed', true]
  ])('shows the %s order status instead of a payment form', async (status, message, resultLink) => {
    ok(checkout({ status, stripe: null }))
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe(message)
    expect(wrapper.find('[data-testid="desktop-checkout-pay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="desktop-checkout-result"]').exists()).toBe(resultLink)
    if (resultLink) {
      expect(wrapper.get('[data-testid="desktop-checkout-result"]').attributes('href')).toBe(RESULT_PATH)
    }
    expect(mocks.loadStripe).not.toHaveBeenCalled()
    expect(mocks.airwallexInit).not.toHaveBeenCalled()
    expectOnlyPublicCheckoutRequests()
  })

  it('treats a pending order without payment data as expired', async () => {
    ok(checkout({ stripe: null }))
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('expired')
  })

  it('says the link expired for an unknown or expired token', async () => {
    reply(404, { code: 404, reason: 'CLAUDEX_CHECKOUT_NOT_FOUND', message: 'This checkout link has expired or isn’t valid.' })
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('notFound')
    expect(wrapper.find('[data-testid="desktop-checkout-retry"]').exists()).toBe(false)
    expect(mocks.loadStripe).not.toHaveBeenCalled()
    expectOnlyPublicCheckoutRequests()
  })

  it('offers a retry after a server or network error, keeping the token in memory only', async () => {
    stripeStub()
    reply(500, { code: 500, message: 'internal error' })
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('loadFailed')

    fetchReplies.push(new TypeError('Failed to fetch'))
    await wrapper.get('[data-testid="desktop-checkout-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('loadFailed')

    ok(checkout())
    await wrapper.get('[data-testid="desktop-checkout-retry"]').trigger('click')
    await settle()
    expect(fetchCalls).toHaveLength(3)
    for (const call of fetchCalls) expect(JSON.parse(String(call.init.body))).toEqual({ token: TOKEN })
    expect(wrapper.find('[data-testid="desktop-checkout-pay"]').exists()).toBe(true)
    expect(window.location.hash).toBe('')
    expectOnlyPublicCheckoutRequests()
  })

  it.each(['', '#', '#t=', '#t=short', `#token=${TOKEN}`, `#t=${TOKEN}x`])(
    'says the link is incomplete for the fragment %j and makes no request',
    async (hash) => {
      openAt(`/desktop-pay${hash}`)
      const wrapper = mountPage()
      await settle()
      expect(window.location.hash).toBe('')
      expect(wrapper.get('[data-testid="desktop-checkout-message"]').attributes('data-message')).toBe('missing')
      expect(fetchCalls).toHaveLength(0)
      expectOnlyPublicCheckoutRequests()
    }
  )

  it('never follows a result path that is not the local result page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { stripe } = stripeStub()
    ok(checkout({ result_path: 'https://evil.example/payment/result' }))
    openAt(`/desktop-pay#t=${TOKEN}`)
    const wrapper = mountPage()
    await settle()
    await wrapper.get('[data-testid="desktop-checkout-pay"]').trigger('click')
    await settle()
    expect(stripe.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ confirmParams: { return_url: `${window.location.origin}/payment/result` } })
    )
    vi.advanceTimersByTime(5000)
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})

describe('/desktop-pay while the web console is for administrators only', () => {
  it('is a public route that signed-out visitors, non-admins and admins all keep', () => {
    const route = claudexPublicRoutes.find((r) => r.path === '/desktop-pay')
    expect(route?.meta?.requiresAuth).toBe(false)
    const lists = { callbackPaths: [], pendingAuthPaths: [] }
    for (const [isAuthenticated, isAdmin] of [
      [false, false],
      [true, false],
      [true, true]
    ]) {
      const access = { adminOnly: true, isAuthenticated, isAdmin, hasPendingAuthSession: false }
      expect(resolveAdminOnlyPublicRedirect({ path: '/desktop-pay' }, access, lists)).toBeNull()
    }
  })
})

describe('claudexCheckout helpers', () => {
  it('reads only a well-formed token from the fragment', () => {
    expect(readCheckoutToken(`#t=${TOKEN}`)).toBe(TOKEN)
    expect(readCheckoutToken(`t=${TOKEN}`)).toBe(TOKEN)
    expect(readCheckoutToken(`#x=1&t=${TOKEN}`)).toBe(TOKEN)
    expect(readCheckoutToken('#t=abc')).toBe('')
    expect(readCheckoutToken(`#t=${TOKEN.slice(0, 42)}+`)).toBe('')
    expect(readCheckoutToken('')).toBe('')
  })

  it('accepts only the local payment result page as a result path', () => {
    expect(safeResultPath(RESULT_PATH)).toBe(RESULT_PATH)
    expect(safeResultPath('/payment/result')).toBe('/payment/result')
    expect(safeResultPath('/payment/results?x=1')).toBe('')
    expect(safeResultPath('//evil.example/payment/result')).toBe('')
    expect(safeResultPath('https://evil.example/payment/result')).toBe('')
    expect(safeResultPath('/login')).toBe('')
    expect(safeResultPath(undefined)).toBe('')
  })
})
