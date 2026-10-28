/**
 * Vue Router configuration for Sub2API frontend
 * Defines all application routes with lazy loading and navigation guards
 */

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { useAdminSettingsStore } from '@/stores/adminSettings'
import { useAdminComplianceStore } from '@/stores/adminCompliance'
import { useNavigationLoadingState } from '@/composables/useNavigationLoading'
import { useRoutePrefetch } from '@/composables/useRoutePrefetch'
import { getSetupStatus } from '@/api/setup'
import { resolveCompletedSetupRedirectPath } from './setupRedirect'
import { resolveRouteDocumentTitle } from './title'
import { claudexAdminRoutes, claudexPublicRoutes } from './claudex' // CLAUDEX
import { useWebConsoleStore } from '@/stores/webConsole' // CLAUDEX
import {
  resolveAdminOnlyProtectedRedirect,
  resolveAdminOnlyPublicRedirect,
  WEB_APP_PATH,
  type AdminOnlyRouteLists,
  type WebConsoleAccess
} from './webConsole' // CLAUDEX

// CLAUDEX: W-CONSOLE console base path (reserved_paths.json console.base)
const CONSOLE_BASE_PATH = '/admin'

/**
 * CLAUDEX: W-CONSOLE whether a path is inside the console (/admin or /admin/...).
 */
export function isConsolePath(path: string): boolean {
  const p = (path || '').toLowerCase()
  return p === CONSOLE_BASE_PATH || p.startsWith(`${CONSOLE_BASE_PATH}/`)
}

/**
 * CLAUDEX: W-CONSOLE leave the console for a page it does not serve (the web
 * app at '/'): a full-page load, since the Go SiteServer routes it to another SPA.
 */
function leaveConsole(path: string): void {
  window.location.replace(path)
}

/**
 * Route definitions with lazy loading
 */
// CLAUDEX: W-CONSOLE the console lives under /admin. Every route is either under
// /admin/ or a console root page listed in internal/web/sitepaths/reserved_paths.json
// (OAuth callbacks, /reset-password, /legal/*, /payment/result, /desktop-*).
// Former user pages live under /admin/my/*. Old root paths are 302'd by the Go
// SiteServer (legacy_redirects); everything else at the root belongs to the web app.
const routes: RouteRecordRaw[] = [
  // ==================== Setup Routes ====================
  {
    path: '/admin/setup', // CLAUDEX: W-CONSOLE
    name: 'Setup',
    component: () => import('@/views/setup/SetupWizardView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Setup'
    }
  },

  // ==================== Public Routes ====================
  {
    path: '/admin/home', // CLAUDEX: W-CONSOLE
    name: 'Home',
    component: () => import('@/views/HomeView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Home'
    }
  },
  {
    path: '/admin/login', // CLAUDEX: W-CONSOLE
    name: 'Login',
    component: () => import('@/views/auth/LoginView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Login',
      titleKey: 'home.login'
    }
  },
  {
    path: '/admin/register', // CLAUDEX: W-CONSOLE
    name: 'Register',
    component: () => import('@/views/auth/RegisterView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Register',
      titleKey: 'auth.createAccount'
    }
  },
  {
    path: '/admin/email-verify', // CLAUDEX: W-CONSOLE
    name: 'EmailVerify',
    component: () => import('@/views/auth/EmailVerifyView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Verify Email'
    }
  },
  {
    path: '/auth/callback',
    name: 'OAuthCallback',
    alias: '/auth/oauth/callback',
    component: () => import('@/views/auth/OAuthCallbackView.vue'),
    meta: {
      requiresAuth: false,
      title: 'OAuth Callback',
      titleKey: 'auth.oauthCallbackPageTitle'
    }
  },
  {
    path: '/auth/linuxdo/callback',
    name: 'LinuxDoOAuthCallback',
    component: () => import('@/views/auth/LinuxDoCallbackView.vue'),
    meta: {
      requiresAuth: false,
      title: 'LinuxDo OAuth Callback',
      titleKey: 'auth.linuxdoCallbackPageTitle'
    }
  },
  {
    path: '/auth/wechat/callback',
    name: 'WeChatOAuthCallback',
    component: () => import('@/views/auth/WechatCallbackView.vue'),
    meta: {
      requiresAuth: false,
      title: 'WeChat OAuth Callback',
      titleKey: 'auth.wechatCallbackPageTitle'
    }
  },
  {
    path: '/auth/wechat/payment/callback',
    name: 'WeChatPaymentOAuthCallback',
    component: () => import('@/views/auth/WechatPaymentCallbackView.vue'),
    meta: {
      requiresAuth: false,
      title: 'WeChat Payment Callback',
      titleKey: 'auth.wechatPaymentCallbackPageTitle'
    }
  },
  {
    path: '/auth/dingtalk/callback',
    name: 'DingTalkOAuthCallback',
    component: () => import('@/views/auth/DingTalkCallbackView.vue'),
    meta: {
      requiresAuth: false,
      title: 'DingTalk OAuth Callback',
      titleKey: 'auth.dingtalkCallbackPageTitle'
    }
  },
  {
    path: '/auth/dingtalk/email-completion',
    name: 'dingtalk-email-completion',
    component: () => import('@/views/auth/DingTalkEmailCompletionView.vue'),
    meta: {
      requiresAuth: false,
      title: 'DingTalk Email Completion'
    }
  },
  {
    path: '/auth/oidc/callback',
    name: 'OIDCOAuthCallback',
    component: () => import('@/views/auth/OidcCallbackView.vue'),
    meta: {
      requiresAuth: false,
      title: 'OIDC OAuth Callback',
      titleKey: 'auth.oidcCallbackPageTitle'
    }
  },
  {
    path: '/admin/forgot-password', // CLAUDEX: W-CONSOLE
    name: 'ForgotPassword',
    component: () => import('@/views/auth/ForgotPasswordView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Forgot Password',
      titleKey: 'auth.forgotPasswordTitle'
    }
  },
  {
    path: '/reset-password',
    name: 'ResetPassword',
    component: () => import('@/views/auth/ResetPasswordView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Reset Password'
    }
  },
  {
    path: '/admin/key-usage', // CLAUDEX: W-CONSOLE
    name: 'KeyUsage',
    component: () => import('@/views/KeyUsageView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Key Usage',
    }
  },
  {
    path: '/legal/:documentId',
    name: 'LegalDocument',
    component: () => import('@/views/public/LegalDocumentView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Legal Document'
    }
  },
  {
    path: '/admin/model-plaza', // CLAUDEX: W-CONSOLE
    name: 'ModelPlaza',
    component: () => import('@/views/ModelPlazaView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Model Plaza',
      titleKey: 'modelPlaza.title'
    }
  },
  // CLAUDEX: /desktop-only (where non-admins land while the web console is for admins only) and /desktop-pay
  ...claudexPublicRoutes,

  // ==================== User Routes ====================
  // CLAUDEX: W-CONSOLE no '/' → '/home' redirect: the root belongs to the web app.
  {
    path: '/admin/my/dashboard', // CLAUDEX: W-CONSOLE
    name: 'Dashboard',
    component: () => import('@/views/user/DashboardView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Dashboard',
      titleKey: 'dashboard.title',
      descriptionKey: 'dashboard.welcomeMessage'
    }
  },
  {
    path: '/admin/my/keys', // CLAUDEX: W-CONSOLE
    name: 'Keys',
    component: () => import('@/views/user/KeysView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'API Keys',
      titleKey: 'keys.title',
      descriptionKey: 'keys.description'
    }
  },
  {
    path: '/admin/my/batch-image', // CLAUDEX: W-CONSOLE
    name: 'BatchImageGuide',
    alias: '/admin/my/docs/batch-image', // CLAUDEX: W-CONSOLE was /docs/batch-image
    component: () => import('@/views/user/BatchImageGuideView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Batch Image Guide',
      titleKey: 'batchImageGuide.title',
      descriptionKey: 'batchImageGuide.description'
    }
  },
  {
    path: '/admin/my/usage', // CLAUDEX: W-CONSOLE
    name: 'Usage',
    component: () => import('@/views/user/UsageView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Usage Records',
      titleKey: 'usage.title',
      descriptionKey: 'usage.description'
    }
  },
  {
    path: '/admin/my/redeem', // CLAUDEX: W-CONSOLE
    name: 'Redeem',
    component: () => import('@/views/user/RedeemView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Redeem Code',
      titleKey: 'redeem.title',
      descriptionKey: 'redeem.description'
    }
  },
  {
    path: '/admin/my/affiliate', // CLAUDEX: W-CONSOLE
    name: 'Affiliate',
    component: () => import('@/views/user/AffiliateView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Affiliate',
      titleKey: 'affiliate.title',
      descriptionKey: 'affiliate.description'
    }
  },
  {
    path: '/admin/my/available-channels', // CLAUDEX: W-CONSOLE
    name: 'UserAvailableChannels',
    component: () => import('@/views/user/AvailableChannelsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Available Channels',
      titleKey: 'availableChannels.title',
      descriptionKey: 'availableChannels.description'
    }
  },
  {
    path: '/admin/my/profile', // CLAUDEX: W-CONSOLE
    name: 'Profile',
    component: () => import('@/views/user/ProfileView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Profile',
      titleKey: 'profile.title',
      descriptionKey: 'profile.description'
    }
  },
  {
    path: '/admin/my/subscriptions', // CLAUDEX: W-CONSOLE
    name: 'Subscriptions',
    component: () => import('@/views/user/SubscriptionsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'My Subscriptions',
      titleKey: 'userSubscriptions.title',
      descriptionKey: 'userSubscriptions.description',
      requiresSubscription: true
    }
  },
  {
    path: '/admin/my/purchase', // CLAUDEX: W-CONSOLE
    name: 'PurchaseSubscription',
    component: () => import('@/views/user/PaymentView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Purchase Subscription',
      titleKey: 'nav.buySubscription',
      descriptionKey: 'purchase.description',
      requiresPayment: true
    }
  },
  {
    path: '/admin/my/orders', // CLAUDEX: W-CONSOLE
    name: 'OrderList',
    component: () => import('@/views/user/UserOrdersView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'My Orders',
      titleKey: 'nav.myOrders',
      requiresPayment: true
    }
  },
  {
    path: '/admin/payment/qrcode', // CLAUDEX: W-CONSOLE
    name: 'PaymentQRCode',
    component: () => import('@/views/user/PaymentQRCodeView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Payment',
      titleKey: 'payment.qr.scanToPay',
      requiresPayment: true
    }
  },
  {
    path: '/payment/result',
    name: 'PaymentResult',
    component: () => import('@/views/user/PaymentResultView.vue'),
    meta: {
      requiresAuth: false,
      requiresAdmin: false,
      title: 'Payment Result',
      titleKey: 'payment.result.success',
      requiresPayment: false
    }
  },
  {
    path: '/admin/payment/stripe', // CLAUDEX: W-CONSOLE
    name: 'StripePayment',
    component: () => import('@/views/user/StripePaymentView.vue'),
    meta: {
      requiresAuth: false,
      requiresAdmin: false,
      title: 'Stripe Payment',
      titleKey: 'payment.stripePay',
      requiresPayment: false
    }
  },
  {
    path: '/admin/payment/airwallex', // CLAUDEX: W-CONSOLE
    name: 'AirwallexPayment',
    component: () => import('@/views/user/AirwallexPaymentView.vue'),
    meta: {
      requiresAuth: false,
      requiresAdmin: false,
      title: 'Airwallex Payment',
      titleKey: 'payment.airwallexPay',
      requiresPayment: false
    }
  },
  {
    path: '/admin/payment/stripe-popup', // CLAUDEX: W-CONSOLE
    name: 'StripePopup',
    component: () => import('@/views/user/StripePopupView.vue'),
    meta: {
      requiresAuth: false,
      requiresAdmin: false,
      title: 'Payment',
      requiresPayment: false
    }
  },
  {
    path: '/admin/my/custom/:id', // CLAUDEX: W-CONSOLE
    name: 'CustomPage',
    component: () => import('@/views/user/CustomPageView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Custom Page',
      titleKey: 'customPage.title',
    }
  },

  // ==================== Admin Routes ====================
  {
    path: '/admin',
    redirect: '/admin/dashboard'
  },
  {
    path: '/admin/dashboard',
    name: 'AdminDashboard',
    component: () => import('@/views/admin/DashboardView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Admin Dashboard',
      titleKey: 'admin.dashboard.title',
      descriptionKey: 'admin.dashboard.description'
    }
  },
  {
    path: '/admin/ops',
    name: 'AdminOps',
    component: () => import('@/views/admin/ops/OpsDashboard.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Ops Monitoring',
      titleKey: 'admin.ops.title',
      descriptionKey: 'admin.ops.description'
    }
  },
  {
    path: '/admin/audit-logs',
    name: 'AdminAuditLogs',
    component: () => import('@/views/admin/AuditLogView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Audit Logs',
      titleKey: 'admin.audit.title',
      descriptionKey: 'admin.audit.description'
    }
  },
  {
    path: '/admin/users',
    name: 'AdminUsers',
    component: () => import('@/views/admin/UsersView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'User Management',
      titleKey: 'admin.users.title',
      descriptionKey: 'admin.users.description'
    }
  },
  {
    path: '/admin/groups',
    name: 'AdminGroups',
    component: () => import('@/views/admin/GroupsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Group Management',
      titleKey: 'admin.groups.title',
      descriptionKey: 'admin.groups.description'
    }
  },
  {
    path: '/admin/channels',
    redirect: '/admin/channels/pricing'
  },
  {
    path: '/admin/channels/pricing',
    name: 'AdminChannels',
    component: () => import('@/views/admin/ChannelsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Channel Management',
      titleKey: 'admin.channels.title',
      descriptionKey: 'admin.channels.description'
    }
  },
  {
    path: '/admin/channels/monitor',
    name: 'AdminChannelMonitor',
    component: () => import('@/views/admin/ChannelMonitorView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Channel Monitor',
      titleKey: 'admin.channelMonitor.title',
      descriptionKey: 'admin.channelMonitor.description'
    }
  },
  {
    path: '/admin/my/monitor', // CLAUDEX: W-CONSOLE
    name: 'ChannelStatus',
    component: () => import('@/views/user/ChannelStatusView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Channel Status',
      titleKey: 'nav.channelStatus'
    }
  },
  {
    path: '/admin/subscriptions',
    name: 'AdminSubscriptions',
    component: () => import('@/views/admin/SubscriptionsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Subscription Management',
      titleKey: 'admin.subscriptions.title',
      descriptionKey: 'admin.subscriptions.description'
    }
  },
  {
    path: '/admin/accounts',
    name: 'AdminAccounts',
    component: () => import('@/views/admin/AccountsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Account Management',
      titleKey: 'admin.accounts.title',
      descriptionKey: 'admin.accounts.description'
    }
  },
  {
    path: '/admin/plugins',
    name: 'AdminPlugins',
    component: () => import('@/views/admin/PluginsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Plugin Management',
      titleKey: 'admin.plugins.title',
      descriptionKey: 'admin.plugins.description'
    }
  },
  {
    path: '/admin/announcements',
    name: 'AdminAnnouncements',
    component: () => import('@/views/admin/AnnouncementsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Announcements',
      titleKey: 'admin.announcements.title',
      descriptionKey: 'admin.announcements.description'
    }
  },
  {
    path: '/admin/proxies',
    name: 'AdminProxies',
    component: () => import('@/views/admin/ProxiesView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Proxy Management',
      titleKey: 'admin.proxies.title',
      descriptionKey: 'admin.proxies.description'
    }
  },
  {
    path: '/admin/redeem',
    name: 'AdminRedeem',
    component: () => import('@/views/admin/RedeemView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Redeem Code Management',
      titleKey: 'admin.redeem.title',
      descriptionKey: 'admin.redeem.description'
    }
  },
  {
    path: '/admin/promo-codes',
    name: 'AdminPromoCodes',
    component: () => import('@/views/admin/PromoCodesView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Promo Code Management',
      titleKey: 'admin.promo.title',
      descriptionKey: 'admin.promo.description'
    }
  },
  {
    path: '/admin/settings',
    name: 'AdminSettings',
    component: () => import('@/views/admin/SettingsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'System Settings',
      titleKey: 'admin.settings.title',
      descriptionKey: 'admin.settings.description'
    }
  },
  {
    path: '/admin/risk-control',
    name: 'AdminRiskControl',
    component: () => import('@/views/admin/RiskControlView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Risk Control',
      titleKey: 'admin.riskControl.title',
      descriptionKey: 'admin.riskControl.description',
      requiresRiskControl: true
    }
  },
  {
    path: '/admin/prompt-audit',
    name: 'AdminPromptAudit',
    component: () => import('@/features/prompt-audit/PromptAuditView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Prompt Audit',
      titleKey: 'admin.promptAudit.title',
      descriptionKey: 'admin.promptAudit.description',
      requiresRiskControl: true
    }
  },
  {
    path: '/admin/usage',
    name: 'AdminUsage',
    component: () => import('@/views/admin/UsageView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Usage Records',
      titleKey: 'admin.usage.title',
      descriptionKey: 'admin.usage.description'
    }
  },
  {
    path: '/admin/affiliates',
    redirect: '/admin/affiliates/invites'
  },
  {
    path: '/admin/affiliates/invites',
    name: 'AdminAffiliateInvites',
    component: () => import('@/views/admin/affiliates/AdminAffiliateInvitesView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Affiliate Invite Records',
      titleKey: 'nav.affiliateInviteRecords',
      descriptionKey: 'admin.affiliates.invitesDescription'
    }
  },
  {
    path: '/admin/affiliates/rebates',
    name: 'AdminAffiliateRebates',
    component: () => import('@/views/admin/affiliates/AdminAffiliateRebatesView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Affiliate Rebate Records',
      titleKey: 'nav.affiliateRebateRecords',
      descriptionKey: 'admin.affiliates.rebatesDescription'
    }
  },
  {
    path: '/admin/affiliates/transfers',
    name: 'AdminAffiliateTransfers',
    component: () => import('@/views/admin/affiliates/AdminAffiliateTransfersView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Affiliate Transfer Records',
      titleKey: 'nav.affiliateTransferRecords',
      descriptionKey: 'admin.affiliates.transfersDescription'
    }
  },


  // ==================== Payment Admin Routes ====================
  {
    path: '/admin/orders/dashboard',
    name: 'AdminPaymentDashboard',
    component: () => import('@/views/admin/orders/AdminPaymentDashboardView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Payment Dashboard',
      titleKey: 'nav.paymentDashboard',
      requiresPayment: true
    }
  },
  {
    path: '/admin/orders',
    name: 'AdminOrders',
    component: () => import('@/views/admin/orders/AdminOrdersView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Order Management',
      titleKey: 'nav.orderManagement',
      requiresPayment: true
    }
  },
  {
    path: '/admin/orders/plans',
    name: 'AdminPaymentPlans',
    component: () => import('@/views/admin/orders/AdminPaymentPlansView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Subscription Plans',
      titleKey: 'nav.paymentPlans',
      requiresPayment: true
    }
  },

  // CLAUDEX: admin-only Claudex pages (/admin/claudex/*)
  ...claudexAdminRoutes,

  // ==================== 404 Not Found ====================
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/NotFoundView.vue'),
    // CLAUDEX: W-CONSOLE the 404 page is shown only under /admin. Any other
    // unknown root path belongs to the Claudex web app: hand it back with a
    // full-page load instead of rendering the console.
    beforeEnter: (to) => {
      if (isConsolePath(to.path)) return true
      leaveConsole(WEB_APP_PATH)
      return false
    },
    meta: {
      title: '404 Not Found'
    }
  }
]

/**
 * Create router instance
 */
const router = createRouter({
  // CLAUDEX: W-CONSOLE history base '/': routes carry their full path (/admin/...
  // plus the console root pages), while assets load from BASE_URL (/admin/).
  history: createWebHistory('/'),
  routes,
  scrollBehavior(_to, _from, savedPosition) {
    // Scroll to saved position when using browser back/forward
    if (savedPosition) {
      return savedPosition
    }
    // Scroll to top for new routes
    return { top: 0 }
  }
})

/**
 * Navigation guard: Authentication check
 */
let authInitialized = false

// 初始化导航加载状态和预加载
const navigationLoading = useNavigationLoadingState()
// 延迟初始化预加载，传入 router 实例
let routePrefetch: ReturnType<typeof useRoutePrefetch> | null = null
// CLAUDEX: W-CONSOLE console pages moved under /admin; callback lists below stay at the root
const BACKEND_MODE_ALLOWED_PATHS = ['/admin/login', '/admin/key-usage', '/admin/setup', '/payment/result', '/admin/payment/airwallex', '/legal']
const BACKEND_MODE_CALLBACK_PATHS = [
  '/auth/callback',
  '/auth/linuxdo/callback',
  '/auth/dingtalk/callback',
  '/auth/dingtalk/email-completion',
  '/auth/oidc/callback',
  '/auth/wechat/callback',
  '/auth/wechat/payment/callback',
]
const BACKEND_MODE_PENDING_AUTH_PATHS = ['/admin/register', '/admin/email-verify'] // CLAUDEX: W-CONSOLE
// CLAUDEX: web_console_admin_only reuses the sign-in callback and pending sign-in pages above
const ADMIN_ONLY_ROUTE_LISTS: AdminOnlyRouteLists = {
  callbackPaths: BACKEND_MODE_CALLBACK_PATHS,
  pendingAuthPaths: BACKEND_MODE_PENDING_AUTH_PATHS
}

function isBackendModePublicRouteAllowed(path: string, hasPendingAuthSession: boolean): boolean {
  if (BACKEND_MODE_ALLOWED_PATHS.some((allowedPath) => path === allowedPath || path.startsWith(allowedPath))) {
    return true
  }

  if (BACKEND_MODE_CALLBACK_PATHS.some((callbackPath) => path === callbackPath)) {
    return true
  }

  if (hasPendingAuthSession && BACKEND_MODE_PENDING_AUTH_PATHS.some((allowedPath) => path === allowedPath)) {
    return true
  }

  return false
}

router.beforeEach(async (to, _from, next) => {
  // 开始导航加载状态
  navigationLoading.startNavigation()

  const authStore = useAuthStore()
  // CLAUDEX: web_console_admin_only, read once per page load (fails closed)
  const webConsole = useWebConsoleStore()
  const webConsoleReady = webConsole.ensureLoaded()

  // Restore auth state from localStorage on first navigation (page refresh)
  if (!authInitialized) {
    authStore.checkAuth()
    authInitialized = true
  }

  // Set page title
  const appStore = useAppStore()
  const adminSettingsStore = useAdminSettingsStore()
  const customMenuItems = [
    ...(appStore.cachedPublicSettings?.custom_menu_items ?? []),
    ...(authStore.isAdmin ? adminSettingsStore.customMenuItems : []),
  ]
  document.title = resolveRouteDocumentTitle(to, appStore.siteName, customMenuItems)

  // Check if route requires authentication
  const requiresAuth = to.meta.requiresAuth !== false // Default to true
  const requiresAdmin = to.meta.requiresAdmin === true

  // CLAUDEX: web console for admins only (router/webConsole.ts)
  await webConsoleReady
  const webConsoleAccess: WebConsoleAccess = {
    adminOnly: webConsole.adminOnly,
    isAuthenticated: authStore.isAuthenticated,
    isAdmin: authStore.isAdmin,
    hasPendingAuthSession: authStore.hasPendingAuthSession
  }

  // CLAUDEX: W-CONSOLE a redirect to the web app ('/') leaves the console with a full-page load
  const go = (target: string) => {
    if (target === WEB_APP_PATH) {
      leaveConsole(WEB_APP_PATH)
      next(false)
      return
    }
    next(target)
  }

  // CLAUDEX: W-CONSOLE an unknown root path belongs to the web app, whoever is signed in
  // (checked before the auth checks, which would otherwise send an anonymous visitor to /admin/login)
  if (to.name === 'NotFound' && !isConsolePath(to.path)) {
    go(WEB_APP_PATH)
    return
  }

  if (to.path === '/admin/setup') { // CLAUDEX: W-CONSOLE
    try {
      const status = await getSetupStatus()
      if (!status.needs_setup) {
        go(resolveCompletedSetupRedirectPath(authStore.isAuthenticated, authStore.isAdmin, webConsole.adminOnly)) // CLAUDEX: adminOnly
        return
      }
    } catch {
      // If setup status cannot be determined, keep the setup page reachable.
    }
  }

  // If route doesn't require auth, allow access
  if (!requiresAuth) {
    // CLAUDEX: while the web console is for admins only, non-admins keep only the allowed public pages
    const adminOnlyRedirect = resolveAdminOnlyPublicRedirect(
      { path: to.path, redirectedFrom: to.redirectedFrom?.path },
      webConsoleAccess,
      ADMIN_ONLY_ROUTE_LISTS
    )
    if (adminOnlyRedirect) {
      go(adminOnlyRedirect) // CLAUDEX: W-CONSOLE
      return
    }
    // If already authenticated and trying to access login/register, redirect to appropriate dashboard
    if (authStore.isAuthenticated && (to.path === '/admin/login' || to.path === '/admin/register')) { // CLAUDEX: W-CONSOLE
      // In backend mode, non-admin users should NOT be redirected away from login
      // (they are blocked from all protected routes, so redirecting would cause a loop)
      if (appStore.backendModeEnabled && !authStore.isAdmin) {
        next()
        return
      }
      // Admin users go to admin dashboard, regular users go to user dashboard
      next(authStore.isAdmin ? '/admin/dashboard' : '/admin/my/dashboard') // CLAUDEX: W-CONSOLE
      return
    }
    // Model Plaza:公开路由但受「启用开关 + 可选强制登录」双重控制(后端同口径 fail-closed)
    if (to.path === '/admin/model-plaza') { // CLAUDEX: W-CONSOLE
      if (!appStore.publicSettingsLoaded) {
        try {
          await appStore.fetchPublicSettings()
        } catch (error) {
          console.warn('Failed to load public settings in route guard', error)
        }
      }
      const plazaSettings = appStore.cachedPublicSettings
      // 仅在设置成功加载且明确为 false 时拦截(瞬时加载失败视为未知,由后端 404 兜底)
      if (appStore.publicSettingsLoaded && plazaSettings?.model_plaza_enabled === false) {
        next(
          authStore.isAuthenticated
            ? authStore.isAdmin
              ? '/admin/dashboard'
              : '/admin/my/dashboard' // CLAUDEX: W-CONSOLE
            : '/admin/home'
        )
        return
      }
      if (plazaSettings?.model_plaza_require_auth === true && !authStore.isAuthenticated) {
        next({ path: '/admin/login', query: { redirect: to.fullPath } }) // CLAUDEX: W-CONSOLE
        return
      }
      // Backend mode:登录的非管理员也不可见(匿名由下方公共拦截处理,广场不在白名单)
      if (appStore.backendModeEnabled && authStore.isAuthenticated && !authStore.isAdmin) {
        next('/admin/login') // CLAUDEX: W-CONSOLE
        return
      }
    }
    // Backend mode: block public pages for unauthenticated users (except login, key-usage, setup)
    if (appStore.backendModeEnabled && !authStore.isAuthenticated) {
      const isAllowed = isBackendModePublicRouteAllowed(to.path, authStore.hasPendingAuthSession)
      if (!isAllowed) {
        next('/admin/login') // CLAUDEX: W-CONSOLE
        return
      }
    }
    next()
    return
  }

  // Route requires authentication
  if (!authStore.isAuthenticated) {
    // Not authenticated, redirect to login
    next({
      path: '/admin/login', // CLAUDEX: W-CONSOLE
      query: { redirect: to.fullPath } // Save intended destination
    })
    return
  }

  // CLAUDEX: a signed-in non-admin goes to the web app while the user pages are closed
  // (before the admin check below, whose /admin/my/dashboard fallback would loop)
  const adminOnlyProtectedRedirect = resolveAdminOnlyProtectedRedirect(webConsoleAccess)
  if (adminOnlyProtectedRedirect) {
    go(adminOnlyProtectedRedirect) // CLAUDEX: W-CONSOLE
    return
  }

  // Check admin requirement
  if (requiresAdmin && !authStore.isAdmin) {
    // User is authenticated but not admin, redirect to user dashboard
    next('/admin/my/dashboard') // CLAUDEX: W-CONSOLE
    return
  }

  if (requiresAdmin && authStore.isAdmin) {
    const adminComplianceStore = useAdminComplianceStore()
    if (!adminComplianceStore.initialized) {
      try {
        await adminComplianceStore.fetchStatus()
      } catch (error) {
        const err = error as { status?: number; code?: string; metadata?: Record<string, string> }
        if (err.status === 423 && err.code === 'ADMIN_COMPLIANCE_ACK_REQUIRED') {
          adminComplianceStore.requireAcknowledgement(err.metadata)
        }
      }
    }
  }


  // 公共设置可能尚未加载（App.vue 的 onMounted 异步拉取晚于首次导航，且纯静态部署
  // 无 __APP_CONFIG__ 注入）。此时 cachedPublicSettings 为空会把 payment/risk_control
  // 误判为“未启用”而错误拦截，故这里先确保设置加载完成。
  if ((to.meta.requiresPayment || to.meta.requiresRiskControl || to.meta.requiresSubscription) && !appStore.publicSettingsLoaded) {
    try {
      await appStore.fetchPublicSettings()
    } catch (error) {
      console.warn('Failed to load public settings in route guard', error)
    }
  }

  // Only an explicit value from successfully loaded settings can disable a route.
  // A transient settings failure is unknown state, not a confirmed feature toggle.
  if (
    to.meta.requiresPayment &&
    appStore.publicSettingsLoaded &&
    appStore.cachedPublicSettings?.payment_enabled === false
  ) {
    next(authStore.isAdmin ? '/admin/dashboard' : '/admin/my/dashboard') // CLAUDEX: W-CONSOLE
    return
  }

  if (
    to.meta.requiresRiskControl &&
    appStore.publicSettingsLoaded &&
    appStore.cachedPublicSettings?.risk_control_enabled === false
  ) {
    next(authStore.isAdmin ? '/admin/settings' : '/admin/my/dashboard') // CLAUDEX: W-CONSOLE
    return
  }

  // 订阅功能是 opt-out 开关：只有显式 false 才拦截「我的订阅」页直达。
  if (
    to.meta.requiresSubscription &&
    appStore.publicSettingsLoaded &&
    appStore.cachedPublicSettings?.subscription_enabled === false
  ) {
    next(authStore.isAdmin ? '/admin/dashboard' : '/admin/my/dashboard') // CLAUDEX: W-CONSOLE
    return
  }

  // 简易模式下限制访问某些页面
  if (authStore.isSimpleMode) {
    const restrictedPaths = [
      '/admin/subscriptions',
      '/admin/redeem',
      '/admin/my/subscriptions', // CLAUDEX: W-CONSOLE
      '/admin/my/redeem'
    ]

    if (restrictedPaths.some((path) => to.path.startsWith(path))) {
      // 简易模式下访问受限页面,重定向到仪表板
      next(authStore.isAdmin ? '/admin/dashboard' : '/admin/my/dashboard') // CLAUDEX: W-CONSOLE
      return
    }
  }

  // Backend mode: admin gets full access, non-admin blocked
  if (appStore.backendModeEnabled) {
    if (authStore.isAuthenticated && authStore.isAdmin) {
      next()
      return
    }
    const isAllowed = isBackendModePublicRouteAllowed(to.path, authStore.hasPendingAuthSession)
    if (!isAllowed) {
      next('/admin/login') // CLAUDEX: W-CONSOLE
      return
    }
  }

  // All checks passed, allow navigation
  next()
})

/**
 * Navigation guard: End loading and trigger prefetch
 */
router.afterEach((to) => {
  // 结束导航加载状态
  navigationLoading.endNavigation()

  // 懒初始化预加载（首次导航时创建，传入 router 实例）
  if (!routePrefetch) {
    routePrefetch = useRoutePrefetch(router)
  }
  // 触发路由预加载（在浏览器空闲时执行）
  routePrefetch.triggerPrefetch(to)
})

/**
 * Navigation guard: Error handling
 * Handles dynamic import failures caused by deployment updates
 */
router.onError((error) => {
  console.error('Router error:', error)

  // Check if this is a dynamic import failure (chunk loading error)
  const isChunkLoadError =
    error.message?.includes('Failed to fetch dynamically imported module') ||
    error.message?.includes('Loading chunk') ||
    error.message?.includes('Loading CSS chunk') ||
    error.name === 'ChunkLoadError'

  if (isChunkLoadError) {
    // Avoid infinite reload loop by checking sessionStorage
    const reloadKey = 'chunk_reload_attempted'
    const lastReload = sessionStorage.getItem(reloadKey)
    const now = Date.now()

    // Allow reload if never attempted or more than 10 seconds ago
    if (!lastReload || now - parseInt(lastReload) > 10000) {
      sessionStorage.setItem(reloadKey, now.toString())
      console.warn('Chunk load error detected, reloading page to fetch latest version...')
      window.location.reload()
    } else {
      console.error('Chunk load error persists after reload. Please clear browser cache.')
    }
  }
})

export default router
