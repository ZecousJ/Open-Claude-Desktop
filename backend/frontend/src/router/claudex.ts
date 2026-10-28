/**
 * CLAUDEX: Claudex routes. The admin-only group /admin/claudex/* holds the
 * Claudex console pages; add a page here and a matching entry to
 * CLAUDEX_ADMIN_NAV so the sidebar's Claudex group lists it. The public
 * /desktop-only page is where non-admins land while the web console is for
 * administrators only (router/webConsole.ts); /desktop-pay is the public
 * checkout page the desktop app opens in the browser for Stripe/Airwallex
 * orders (B10).
 *
 * The public hosted-share pages /s/<token> (R1) are not Vue routes: the Go
 * server renders them and the embedded console never serves paths under /s/,
 * so no route here may start with /s/.
 */

import type { RouteRecordRaw } from 'vue-router'

export interface ClaudexAdminNavEntry {
  path: string
  /** i18n key of the sidebar label */
  titleKey: string
}

/** Sidebar children of the admin-only Claudex group, in display order. */
export const CLAUDEX_ADMIN_NAV: ClaudexAdminNavEntry[] = [
  { path: '/admin/claudex/overview', titleKey: 'admin.claudex.nav.overview' },
  { path: '/admin/claudex/policy', titleKey: 'admin.claudex.nav.policy' },
  { path: '/admin/claudex/models', titleKey: 'admin.claudex.nav.models' },
  { path: '/admin/claudex/directory-submissions', titleKey: 'admin.claudex.directory.title' },
  { path: '/admin/claudex/devices', titleKey: 'admin.claudex.nav.devices' },
  { path: '/admin/claudex/usage-rules', titleKey: 'admin.claudex.nav.usageRules' },
  { path: '/admin/claudex/release', titleKey: 'admin.claudex.nav.release' },
  { path: '/admin/claudex/voice', titleKey: 'admin.claudex.nav.voice' },
  { path: '/admin/claudex/feedback', titleKey: 'admin.claudex.nav.feedback' },
  { path: '/admin/claudex/sharing', titleKey: 'admin.claudexSharing.nav' },
  { path: '/admin/claudex/announcements', titleKey: 'admin.claudexAnnouncements.nav' },
  { path: '/admin/claudex/status', titleKey: 'admin.claudexStatus.nav' },
  { path: '/admin/claudex/github', titleKey: 'admin.claudexGitHub.nav' },
  { path: '/admin/claudex/memory', titleKey: 'admin.claudexMemory.nav' },
  { path: '/admin/claudex/web', titleKey: 'admin.claudexWeb.nav' },
  { path: '/admin/claudex/general', titleKey: 'admin.claudex.nav.general' }
]

export const claudexAdminRoutes: RouteRecordRaw[] = [
  {
    path: '/admin/claudex',
    redirect: '/admin/claudex/overview'
  },
  {
    path: '/admin/claudex/overview',
    name: 'AdminClaudexOverview',
    component: () => import('@/views/admin/claudex/ClaudexOverviewView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Claudex',
      titleKey: 'admin.claudex.overview.title',
      descriptionKey: 'admin.claudex.overview.description'
    }
  },
  {
    path: '/admin/claudex/policy',
    name: 'AdminClaudexPolicy',
    component: () => import('@/views/admin/claudex/ClaudexPolicyView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Client policy',
      titleKey: 'admin.claudexPolicy.title',
      descriptionKey: 'admin.claudexPolicy.description'
    }
  },
  {
    path: '/admin/claudex/models',
    name: 'AdminClaudexModels',
    component: () => import('@/views/admin/claudex/ClaudexModelsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Model catalog',
      titleKey: 'admin.claudexModels.title',
      descriptionKey: 'admin.claudexModels.description'
    }
  },
  {
    path: '/admin/claudex/directory-submissions',
    name: 'AdminClaudexDirectorySubmissions',
    component: () => import('@/views/admin/claudex/ClaudexDirectorySubmissionsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true, title: 'Directory submissions', titleKey: 'admin.claudex.directory.title', descriptionKey: 'admin.claudex.directory.description' }
  },
  {
    path: '/admin/claudex/devices',
    name: 'AdminClaudexDevices',
    component: () => import('@/views/admin/claudex/ClaudexDevicesView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Devices',
      titleKey: 'admin.claudexDevices.title',
      descriptionKey: 'admin.claudexDevices.description'
    }
  },
  {
    path: '/admin/claudex/usage-rules',
    name: 'AdminClaudexUsageRules',
    component: () => import('@/views/admin/claudex/ClaudexUsageRulesView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Usage rules',
      titleKey: 'admin.claudexUsageRules.title',
      descriptionKey: 'admin.claudexUsageRules.description'
    }
  },
  {
    path: '/admin/claudex/release',
    name: 'AdminClaudexRelease',
    component: () => import('@/views/admin/claudex/ClaudexReleaseView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Desktop release',
      titleKey: 'admin.claudexRelease.title',
      descriptionKey: 'admin.claudexRelease.description'
    }
  },
  {
    path: '/admin/claudex/voice',
    name: 'AdminClaudexVoice',
    component: () => import('@/views/admin/claudex/ClaudexVoiceView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Voice',
      titleKey: 'admin.claudexVoice.title',
      descriptionKey: 'admin.claudexVoice.description'
    }
  },
  {
    path: '/admin/claudex/feedback',
    name: 'AdminClaudexFeedback',
    component: () => import('@/views/admin/claudex/ClaudexFeedbackView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Diagnostics and feedback',
      titleKey: 'admin.claudexFeedback.title',
      descriptionKey: 'admin.claudexFeedback.description'
    }
  },
  {
    path: '/admin/claudex/sharing',
    name: 'AdminClaudexSharing',
    component: () => import('@/views/admin/claudex/ClaudexSharingView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Sharing',
      titleKey: 'admin.claudexSharing.title',
      descriptionKey: 'admin.claudexSharing.description'
    }
  },
  {
    path: '/admin/claudex/announcements',
    name: 'AdminClaudexAnnouncements',
    component: () => import('@/views/admin/claudex/ClaudexAnnouncementsView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Announcements',
      titleKey: 'admin.claudexAnnouncements.title',
      descriptionKey: 'admin.claudexAnnouncements.description'
    }
  },
  {
    path: '/admin/claudex/status',
    name: 'AdminClaudexStatus',
    component: () => import('@/views/admin/claudex/ClaudexStatusView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Service status',
      titleKey: 'admin.claudexStatus.title',
      descriptionKey: 'admin.claudexStatus.description'
    }
  },
  {
    path: '/admin/claudex/github',
    name: 'AdminClaudexGitHub',
    component: () => import('@/views/admin/claudex/ClaudexGitHubView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'GitHub',
      titleKey: 'admin.claudexGitHub.title',
      descriptionKey: 'admin.claudexGitHub.description'
    }
  },
  {
    path: '/admin/claudex/memory',
    name: 'AdminClaudexMemory',
    component: () => import('@/views/admin/claudex/memory/ClaudexMemoryView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Memory',
      titleKey: 'admin.claudexMemory.title',
      descriptionKey: 'admin.claudexMemory.description'
    }
  },
  {
    path: '/admin/claudex/web',
    name: 'AdminClaudexWeb',
    component: () => import('@/views/admin/claudex/ClaudexWebView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'Web app',
      titleKey: 'admin.claudexWeb.title',
      descriptionKey: 'admin.claudexWeb.description'
    }
  },
  {
    path: '/admin/claudex/general',
    name: 'AdminClaudexGeneral',
    component: () => import('@/views/admin/claudex/ClaudexGeneralView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true,
      title: 'General',
      titleKey: 'admin.claudexGeneral.title',
      descriptionKey: 'admin.claudexGeneral.description'
    }
  }
]

/** Public Claudex pages (requiresAuth: false). */
export const claudexPublicRoutes: RouteRecordRaw[] = [
  {
    path: '/desktop-only',
    name: 'ClaudexDesktopOnly',
    component: () => import('@/views/public/DesktopOnlyView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Use the Claudex desktop app',
      titleKey: 'desktopOnly.title'
    }
  },
  {
    path: '/desktop-pay',
    name: 'ClaudexDesktopCheckout',
    component: () => import('@/views/public/DesktopCheckoutView.vue'),
    meta: {
      requiresAuth: false,
      title: 'Checkout',
      titleKey: 'desktopCheckout.title'
    }
  }
]
