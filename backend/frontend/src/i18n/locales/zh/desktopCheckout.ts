// CLAUDEX: /desktop-pay 页面文案（desktopCheckout 下的键），即 Claudex 桌面端为 Stripe、
// Airwallex 订单在浏览器中打开的公开结账页（B10）。
export default {
  desktopCheckout: {
    title: '结账',
    loading: '正在加载订单…',
    orderNumber: '订单 #{id}',
    amountDue: '应付金额',
    pay: '支付 {amount}',
    paying: '处理中…',
    openingAirwallex: '正在打开 Airwallex 收银台…',
    succeeded: '已收到付款',
    succeededBody: '正在前往支付结果页…',
    returnHint: '完成后请回到 Claudex，它会自动更新。',
    viewResult: '查看支付状态',
    retry: '重试',
    missing: '此结账链接不完整。请回到 Claudex 重新选择付款。',
    notFound: '此结账链接已失效。请回到 Claudex 重试。',
    expired: '此订单已过期。请回到 Claudex 重新下单。',
    paid: '此订单已支付。你可以关闭此页面并回到 Claudex。',
    closed: '此订单已无法支付。请回到 Claudex 重新下单。',
    loadFailed: '无法加载此结账页。请检查网络后重试。',
    stripeLoadFailed: '无法加载支付表单。请重试，或回到 Claudex 选择其他付款方式。',
    airwallexLoadFailed: '无法打开 Airwallex 收银台。请重试，或回到 Claudex 选择其他付款方式。',
    paymentFailed: '付款未成功。请检查付款信息后重试。'
  }
}
