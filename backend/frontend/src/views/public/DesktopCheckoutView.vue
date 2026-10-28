<!--
  CLAUDEX: /desktop-pay, the public checkout page the Claudex desktop app opens
  in the system browser for Stripe/Airwallex orders (design 2.11, B10; owner
  decision 2).

  The desktop app opens /desktop-pay#t=<token>. The page takes the token from
  the URL fragment and removes it from the address bar at once, then loads the
  order with the public POST /api/v1/claudex/payment/checkout (fetch only: no
  sign-in, no axios client, no localStorage). It mounts the Stripe Payment
  Element or opens the Airwallex checkout and, once paid, goes to the upstream
  public result page (/payment/result?resume_token=...). The desktop app polls
  the order meanwhile and refreshes itself. The upstream StripePaymentView and
  AirwallexPaymentView are left untouched; the mounting below follows them.
  CLAUDEX: LOGIN restyled on ClaudexPublicLayout (the sign-in page's look).
-->
<template>
  <!-- CLAUDEX: LOGIN the sign-in page's look (ClaudexPublicLayout) instead of AuthLayout -->
  <ClaudexPublicLayout :wide="phase === 'stripe'">
    <template #heading>
      <h1 class="cx-public__title">{{ t('desktopCheckout.title') }}</h1>
      <p v-if="checkout" class="cx-public__subtitle" data-testid="desktop-checkout-order">
        {{ t('desktopCheckout.orderNumber', { id: checkout.order_id }) }}
      </p>
    </template>

    <div class="cx-stack" data-testid="desktop-checkout">
      <div
        v-if="phase === 'loading'"
        class="cx-stack items-center py-4"
        role="status"
        data-testid="desktop-checkout-loading"
      >
        <div class="cx-spinner"></div>
        <p class="cx-text">{{ t('desktopCheckout.loading') }}</p>
      </div>

      <template v-else-if="phase === 'message'">
        <p
          role="status"
          class="cx-text"
          :class="{ 'cx-text--error': messageTone === 'error' }"
          data-testid="desktop-checkout-message"
          :data-message="messageKey"
        >
          {{ t(`desktopCheckout.${messageKey}`) }}
        </p>
        <button
          v-if="canRetry"
          type="button"
          class="cx-btn cx-btn--primary"
          data-testid="desktop-checkout-retry"
          @click="load"
        >
          {{ t('desktopCheckout.retry') }}
        </button>
        <router-link
          v-if="showResultLink && resultPath"
          :to="resultPath"
          class="cx-btn cx-btn--secondary"
          data-testid="desktop-checkout-result"
        >
          {{ t('desktopCheckout.viewResult') }}
        </router-link>
      </template>

      <template v-else-if="phase === 'stripe' || phase === 'airwallex' || phase === 'succeeded'">
        <div v-if="checkout" class="cx-center">
          <p class="cx-print">{{ t('desktopCheckout.amountDue') }}</p>
          <p class="cx-amount mt-1.5" data-testid="desktop-checkout-amount">
            {{ amountLabel }}
          </p>
        </div>

        <div v-if="phase === 'stripe'" class="cx-stack">
          <div id="desktop-checkout-stripe-element" ref="stripeHost" class="min-h-[200px]"></div>
          <p v-if="stripeError" role="alert" class="cx-text cx-text--error" data-testid="desktop-checkout-error">
            {{ stripeError }}
          </p>
          <button
            type="button"
            class="cx-btn cx-btn--primary"
            :disabled="!stripeReady || submitting"
            data-testid="desktop-checkout-pay"
            @click="payWithStripe"
          >
            {{ submitting ? t('desktopCheckout.paying') : t('desktopCheckout.pay', { amount: amountLabel }) }}
          </button>
        </div>

        <div
          v-else-if="phase === 'airwallex'"
          class="cx-stack items-center py-4"
          role="status"
          data-testid="desktop-checkout-airwallex"
        >
          <div class="cx-spinner"></div>
          <p class="cx-text">{{ t('desktopCheckout.openingAirwallex') }}</p>
        </div>

        <div v-else class="cx-stack cx-stack--tight cx-center" role="status" data-testid="desktop-checkout-succeeded">
          <p class="cx-text"><strong>{{ t('desktopCheckout.succeeded') }}</strong></p>
          <p class="cx-text">{{ t('desktopCheckout.succeededBody') }}</p>
        </div>
      </template>
    </div>

    <template v-if="phase === 'stripe' || phase === 'airwallex' || phase === 'succeeded'" #footer>
      {{ t('desktopCheckout.returnHint') }}
    </template>
  </ClaudexPublicLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { Stripe, StripeElements, StripePaymentElement } from '@stripe/stripe-js'
import ClaudexPublicLayout from '@/components/layout/ClaudexPublicLayout.vue' // CLAUDEX: LOGIN
import { formatPaymentAmount } from '@/components/payment/currency'
import {
  DesktopCheckoutError,
  fetchDesktopCheckout,
  readCheckoutToken,
  safeResultPath,
  type DesktopCheckout
} from '@/api/claudexCheckout'

type Phase = 'loading' | 'message' | 'stripe' | 'airwallex' | 'succeeded'
type MessageKey =
  | 'missing'
  | 'notFound'
  | 'expired'
  | 'paid'
  | 'closed'
  | 'loadFailed'
  | 'stripeLoadFailed'
  | 'airwallexLoadFailed'

/** Order statuses that mean the money has arrived (upstream payment_order statuses). */
const PAID_STATUSES = new Set(['PAID', 'RECHARGING', 'COMPLETED'])
/** How long the "Payment received" note stays before the result page opens. */
const RESULT_REDIRECT_DELAY_MS = 1500

const { t, locale } = useI18n()
const router = useRouter()

/**
 * Take the token out of the URL fragment before anything else runs and drop
 * the fragment from the address bar (and so from history, bookmarks and
 * copied links). Fragments never reach the server or a Referer header.
 */
function takeTokenFromFragment(): string {
  if (typeof window === 'undefined') return ''
  const token = readCheckoutToken(window.location.hash)
  if (window.location.hash) {
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    } catch {
      // The token stays in memory either way.
    }
  }
  return token
}
const token = takeTokenFromFragment()

const phase = ref<Phase>('loading')
const messageKey = ref<MessageKey>('loadFailed')
const messageTone = ref<'info' | 'error'>('info')
const canRetry = ref(false)
const showResultLink = ref(false)
const checkout = ref<DesktopCheckout | null>(null)
const stripeHost = ref<HTMLElement | null>(null)
const stripeReady = ref(false)
const submitting = ref(false)
const stripeError = ref('')

let stripeInstance: Stripe | null = null
let elementsInstance: StripeElements | null = null
let paymentElement: StripePaymentElement | null = null
let redirectTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

const resultPath = computed(() => safeResultPath(checkout.value?.result_path))

const localeCode = computed(() => {
  const raw = locale as unknown
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && 'value' in raw) return String((raw as { value?: string }).value || '')
  return ''
})

const amountLabel = computed(() =>
  checkout.value ? formatPaymentAmount(checkout.value.pay_amount, checkout.value.currency, localeCode.value || undefined) : ''
)

function showMessage(
  key: MessageKey,
  options: { tone?: 'info' | 'error'; retry?: boolean; resultLink?: boolean } = {}
) {
  messageKey.value = key
  messageTone.value = options.tone ?? 'info'
  canRetry.value = options.retry ?? false
  showResultLink.value = options.resultLink ?? false
  phase.value = 'message'
}

/** Absolute URL of the result page, for the payment providers' return URLs. */
function absoluteResultUrl(): string {
  return new URL(resultPath.value || '/payment/result', window.location.origin).toString()
}

function goToResult() {
  if (disposed || !resultPath.value) return
  void router.replace(resultPath.value)
}

async function load() {
  if (!token) {
    showMessage('missing', { tone: 'error' })
    return
  }
  phase.value = 'loading'
  stripeReady.value = false
  stripeError.value = ''
  let data: DesktopCheckout
  try {
    data = await fetchDesktopCheckout(token)
  } catch (err) {
    if (err instanceof DesktopCheckoutError && err.status === 404) {
      showMessage('notFound', { tone: 'error' })
    } else {
      showMessage('loadFailed', { tone: 'error', retry: true })
    }
    return
  }
  if (disposed) return
  checkout.value = data

  if (PAID_STATUSES.has(data.status)) {
    showMessage('paid', { resultLink: true })
  } else if (data.status === 'PENDING' && data.provider === 'stripe' && data.stripe) {
    phase.value = 'stripe'
    await nextTick()
    await mountStripe(data)
  } else if (data.status === 'PENDING' && data.provider === 'airwallex' && data.airwallex) {
    phase.value = 'airwallex'
    await openAirwallex(data)
  } else if (data.status === 'PENDING' || data.status === 'EXPIRED') {
    showMessage('expired', { tone: 'error' })
  } else {
    showMessage('closed', { tone: 'error', resultLink: true })
  }
}

async function mountStripe(data: DesktopCheckout) {
  const stripeData = data.stripe
  if (!stripeData?.publishable_key || !stripeData.client_secret) {
    showMessage('stripeLoadFailed', { tone: 'error', retry: true })
    return
  }
  try {
    const { loadStripe } = await import('@stripe/stripe-js/pure')
    const stripe = await loadStripe(stripeData.publishable_key)
    if (disposed) return
    if (!stripe || !stripeHost.value) {
      showMessage('stripeLoadFailed', { tone: 'error', retry: true })
      return
    }
    destroyPaymentElement() // a retry mounts a fresh one
    stripeInstance = stripe
    const isDark = document.documentElement.classList.contains('dark')
    elementsInstance = stripe.elements({
      clientSecret: stripeData.client_secret,
      appearance: { theme: isDark ? 'night' : 'stripe', variables: { borderRadius: '8px' } }
    })
    paymentElement = elementsInstance.create('payment', {
      layout: 'tabs',
      paymentMethodOrder: ['alipay', 'wechat_pay', 'card', 'link']
    })
    paymentElement.on('ready', () => {
      stripeReady.value = true
    })
    paymentElement.on('loaderror', () => {
      showMessage('stripeLoadFailed', { tone: 'error', retry: true })
    })
    paymentElement.mount(stripeHost.value)
  } catch {
    showMessage('stripeLoadFailed', { tone: 'error', retry: true })
  }
}

async function payWithStripe() {
  if (!stripeInstance || !elementsInstance || submitting.value) return
  submitting.value = true
  stripeError.value = ''
  try {
    // Methods that leave the page (Alipay, some wallets) come back to the
    // result page; the others finish here.
    const { error } = await stripeInstance.confirmPayment({
      elements: elementsInstance,
      confirmParams: { return_url: absoluteResultUrl() },
      redirect: 'if_required'
    })
    if (error) {
      stripeError.value = error.message || t('desktopCheckout.paymentFailed')
      return
    }
    phase.value = 'succeeded'
    redirectTimer = setTimeout(goToResult, RESULT_REDIRECT_DELAY_MS)
  } catch {
    stripeError.value = t('desktopCheckout.paymentFailed')
  } finally {
    submitting.value = false
  }
}

async function openAirwallex(data: DesktopCheckout) {
  const awx = data.airwallex
  if (!awx) return
  try {
    const airwallex = await import('@airwallex/components-sdk')
    const checkoutLocale = localeCode.value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const result = await airwallex.init({
      env: awx.env === 'prod' ? 'prod' : 'demo',
      enabledElements: ['payments'],
      locale: checkoutLocale
    })
    if (disposed) return
    if (!result.payments) {
      showMessage('airwallexLoadFailed', { tone: 'error', retry: true })
      return
    }
    const redirect = result.payments.redirectToCheckout({
      intent_id: awx.intent_id,
      client_secret: awx.client_secret,
      currency: awx.currency || 'CNY',
      country_code: awx.country_code || 'CN',
      successUrl: absoluteResultUrl()
    })
    if (typeof redirect === 'string' && redirect) {
      window.location.assign(redirect)
    }
  } catch {
    showMessage('airwallexLoadFailed', { tone: 'error', retry: true })
  }
}

onMounted(() => {
  void load()
})

function destroyPaymentElement() {
  try {
    paymentElement?.destroy()
  } catch {
    // Already gone.
  }
  paymentElement = null
  elementsInstance = null
  stripeInstance = null
}

onBeforeUnmount(() => {
  disposed = true
  if (redirectTimer) clearTimeout(redirectTimer)
  destroyPaymentElement()
})
</script>
