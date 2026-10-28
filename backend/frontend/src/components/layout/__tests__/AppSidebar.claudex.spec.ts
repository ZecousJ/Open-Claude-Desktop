// CLAUDEX: the sidebar parts of the Claudex console (admin-only Claudex group and
// no user menu while the web console is for administrators only).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CLAUDEX_ADMIN_NAV, claudexAdminRoutes, claudexPublicRoutes } from '@/router/claudex'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'

const sidebarSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../AppSidebar.vue'),
  'utf8'
)

function lookup(messages: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

describe('AppSidebar Claudex parts', () => {
  it('hides the user menu while the web console is for admins only', () => {
    expect(sidebarSource).toContain('v-else-if="!appStore.backendModeEnabled && !webConsole.adminOnly"')
    expect(sidebarSource).toContain("import { useWebConsoleStore } from '@/stores/webConsole'")
  })

  it('lists the Claudex group before Proxies, built from CLAUDEX_ADMIN_NAV, and not the upstream Announcements', () => {
    expect(sidebarSource).not.toContain("path: '/admin/announcements'")
    const group = sidebarSource.indexOf("path: '/admin/claudex'")
    const proxies = sidebarSource.indexOf("path: '/admin/proxies'")
    expect(group).toBeGreaterThan(0)
    expect(group).toBeLessThan(proxies)
    const block = sidebarSource.slice(group, proxies)
    expect(block).toContain('expandOnly: true')
    expect(block).toContain("label: t('admin.claudex.nav.root')")
    expect(block).toContain('CLAUDEX_ADMIN_NAV.map')
  })

  it('has a route and a label in both languages for every Claudex menu entry', () => {
    const routePaths = new Set(claudexAdminRoutes.map((route) => route.path))
    expect(CLAUDEX_ADMIN_NAV.map((entry) => entry.path)).toEqual([
      '/admin/claudex/overview',
      '/admin/claudex/policy',
      '/admin/claudex/models',
      '/admin/claudex/directory-submissions',
      '/admin/claudex/devices',
      '/admin/claudex/usage-rules',
      '/admin/claudex/release',
      '/admin/claudex/voice',
      '/admin/claudex/feedback',
      '/admin/claudex/sharing',
      '/admin/claudex/announcements',
      '/admin/claudex/status',
      '/admin/claudex/github',
      '/admin/claudex/memory',
      '/admin/claudex/web',
      '/admin/claudex/general'
    ])
    for (const entry of CLAUDEX_ADMIN_NAV) {
      expect(routePaths.has(entry.path), entry.path).toBe(true)
      expect(lookup(en, entry.titleKey), entry.titleKey).toBeTruthy()
      expect(lookup(zh, entry.titleKey), entry.titleKey).toBeTruthy()
    }
  })

  it('keeps every Claudex console page admin-only and /desktop-only and /desktop-pay public', () => {
    for (const route of claudexAdminRoutes.filter((route) => !route.redirect)) {
      expect(route.meta?.requiresAuth, route.path).toBe(true)
      expect(route.meta?.requiresAdmin, route.path).toBe(true)
    }
    expect(claudexPublicRoutes.map((route) => route.path)).toEqual(['/desktop-only', '/desktop-pay'])
    for (const route of claudexPublicRoutes) {
      expect(route.meta?.requiresAuth, route.path).toBe(false)
      expect(route.meta?.requiresAdmin, route.path).toBeUndefined()
      const titleKey = String(route.meta?.titleKey)
      expect(lookup(en, titleKey), titleKey).toBeTruthy()
      expect(lookup(zh, titleKey), titleKey).toBeTruthy()
    }
  })
})
