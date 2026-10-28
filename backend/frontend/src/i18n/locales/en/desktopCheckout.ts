// CLAUDEX: strings for /desktop-pay (keys under desktopCheckout), the public
// checkout page the Claudex desktop app opens in the browser for Stripe and
// Airwallex orders (B10).
export default {
  desktopCheckout: {
    title: 'Checkout',
    loading: 'Loading your order…',
    orderNumber: 'Order #{id}',
    amountDue: 'Amount due',
    pay: 'Pay {amount}',
    paying: 'Processing…',
    openingAirwallex: 'Opening the Airwallex checkout…',
    succeeded: 'Payment received',
    succeededBody: 'Taking you to your payment status…',
    returnHint: 'When you’re done, go back to Claudex. It updates on its own.',
    viewResult: 'View payment status',
    retry: 'Try again',
    missing: 'This checkout link is incomplete. Go back to Claudex and choose Pay again.',
    notFound: 'This checkout link has expired. Go back to Claudex to try again.',
    expired: 'This order has expired. Go back to Claudex to place a new one.',
    paid: 'This order is already paid. You can close this page and go back to Claudex.',
    closed: 'This order can no longer be paid. Go back to Claudex to place a new one.',
    loadFailed: 'Couldn’t load this checkout. Check your connection and try again.',
    stripeLoadFailed: 'Couldn’t load the payment form. Try again, or go back to Claudex to choose another way to pay.',
    airwallexLoadFailed:
      'Couldn’t open the Airwallex checkout. Try again, or go back to Claudex to choose another way to pay.',
    paymentFailed: 'The payment didn’t go through. Check your details and try again.'
  }
}
