import { describe, expect, it } from 'vitest'

import enAdminAccounts from '../locales/en/admin/accounts'
import enAdminChannels from '../locales/en/admin/channels'
import enAdminClaudex from '../locales/en/admin/claudex' // CLAUDEX
import enAdminClaudexPolicy from '../locales/en/admin/claudexPolicy' // CLAUDEX
import enAdminClaudexModels from '../locales/en/admin/claudexModels' // CLAUDEX
import enAdminClaudexDevices from '../locales/en/admin/claudexDevices' // CLAUDEX
import enAdminClaudexUsageRules from '../locales/en/admin/claudexUsageRules' // CLAUDEX
import enAdminClaudexRelease from '../locales/en/admin/claudexRelease' // CLAUDEX
import enAdminClaudexGeneral from '../locales/en/admin/claudexGeneral' // CLAUDEX
import enAdminClaudexVoice from '../locales/en/admin/claudexVoice' // CLAUDEX
import enAdminClaudexFeedback from '../locales/en/admin/claudexFeedback' // CLAUDEX
import enAdminClaudexSharing from '../locales/en/admin/claudexSharing' // CLAUDEX
import enAdminClaudexGitHub from '../locales/en/admin/claudexGitHub' // CLAUDEX
import enAdminClaudexMemory from '../locales/en/admin/claudexMemory' // CLAUDEX
import enAdminClaudexWeb from '../locales/en/admin/claudexWeb' // CLAUDEX
import enAdminOps from '../locales/en/admin/ops'
import enAdminOverview from '../locales/en/admin/overview'
import enAdminResources from '../locales/en/admin/resources'
import enAdminSettings from '../locales/en/admin/settings'
import enCommon from '../locales/en/common'
import enDashboard from '../locales/en/dashboard'
import enLanding from '../locales/en/landing'
import enMisc from '../locales/en/misc'
import enDesktopOnly from '../locales/en/desktopOnly' // CLAUDEX
import enDesktopCheckout from '../locales/en/desktopCheckout' // CLAUDEX
import zhAdminAccounts from '../locales/zh/admin/accounts'
import zhAdminChannels from '../locales/zh/admin/channels'
import zhAdminClaudex from '../locales/zh/admin/claudex' // CLAUDEX
import zhAdminClaudexPolicy from '../locales/zh/admin/claudexPolicy' // CLAUDEX
import zhAdminClaudexModels from '../locales/zh/admin/claudexModels' // CLAUDEX
import zhAdminClaudexDevices from '../locales/zh/admin/claudexDevices' // CLAUDEX
import zhAdminClaudexUsageRules from '../locales/zh/admin/claudexUsageRules' // CLAUDEX
import zhAdminClaudexRelease from '../locales/zh/admin/claudexRelease' // CLAUDEX
import zhAdminClaudexGeneral from '../locales/zh/admin/claudexGeneral' // CLAUDEX
import zhAdminClaudexVoice from '../locales/zh/admin/claudexVoice' // CLAUDEX
import zhAdminClaudexFeedback from '../locales/zh/admin/claudexFeedback' // CLAUDEX
import zhAdminClaudexSharing from '../locales/zh/admin/claudexSharing' // CLAUDEX
import zhAdminClaudexGitHub from '../locales/zh/admin/claudexGitHub' // CLAUDEX
import zhAdminClaudexMemory from '../locales/zh/admin/claudexMemory' // CLAUDEX
import zhAdminClaudexWeb from '../locales/zh/admin/claudexWeb' // CLAUDEX
import zhAdminOps from '../locales/zh/admin/ops'
import zhAdminOverview from '../locales/zh/admin/overview'
import zhAdminResources from '../locales/zh/admin/resources'
import zhAdminSettings from '../locales/zh/admin/settings'
import zhCommon from '../locales/zh/common'
import zhDashboard from '../locales/zh/dashboard'
import zhLanding from '../locales/zh/landing'
import zhMisc from '../locales/zh/misc'
import zhDesktopOnly from '../locales/zh/desktopOnly' // CLAUDEX
import zhDesktopCheckout from '../locales/zh/desktopCheckout' // CLAUDEX

// locales/{zh,en}/index.ts 与 admin/index.ts 使用对象展开聚合各域模块，
// 展开模块之间若出现同名顶层键会静默覆盖。本测试将该风险固化为显式失败。
type Modules = Record<string, Record<string, unknown>>

function collisions(modules: Modules): string[] {
  const seen = new Map<string, string>()
  const out: string[] = []
  for (const [name, mod] of Object.entries(modules)) {
    for (const key of Object.keys(mod)) {
      const prev = seen.get(key)
      if (prev) {
        out.push(`"${key}" in both ${prev} and ${name}`)
      } else {
        seen.set(key, name)
      }
    }
  }
  return out
}

const roots: Record<string, Modules> = {
  zh: {
    landing: zhLanding,
    common: zhCommon,
    dashboard: zhDashboard,
    misc: zhMisc,
    desktopOnly: zhDesktopOnly, // CLAUDEX
    desktopCheckout: zhDesktopCheckout // CLAUDEX
  },
  en: {
    landing: enLanding,
    common: enCommon,
    dashboard: enDashboard,
    misc: enMisc,
    desktopOnly: enDesktopOnly, // CLAUDEX
    desktopCheckout: enDesktopCheckout // CLAUDEX
  }
}

const admins: Record<string, Modules> = {
  zh: {
    overview: zhAdminOverview,
    channels: zhAdminChannels,
    accounts: zhAdminAccounts,
    resources: zhAdminResources,
    ops: zhAdminOps,
    settings: zhAdminSettings,
    // CLAUDEX: the Claudex console modules
    claudex: zhAdminClaudex,
    claudexPolicy: zhAdminClaudexPolicy,
    claudexModels: zhAdminClaudexModels,
    claudexDevices: zhAdminClaudexDevices,
    claudexUsageRules: zhAdminClaudexUsageRules,
    claudexRelease: zhAdminClaudexRelease,
    claudexGeneral: zhAdminClaudexGeneral,
    claudexVoice: zhAdminClaudexVoice,
    claudexFeedback: zhAdminClaudexFeedback,
    claudexSharing: zhAdminClaudexSharing,
    claudexGitHub: zhAdminClaudexGitHub,
    claudexMemory: zhAdminClaudexMemory,
    claudexWeb: zhAdminClaudexWeb
  },
  en: {
    overview: enAdminOverview,
    channels: enAdminChannels,
    accounts: enAdminAccounts,
    resources: enAdminResources,
    ops: enAdminOps,
    settings: enAdminSettings,
    // CLAUDEX: the Claudex console modules
    claudex: enAdminClaudex,
    claudexPolicy: enAdminClaudexPolicy,
    claudexModels: enAdminClaudexModels,
    claudexDevices: enAdminClaudexDevices,
    claudexUsageRules: enAdminClaudexUsageRules,
    claudexRelease: enAdminClaudexRelease,
    claudexGeneral: enAdminClaudexGeneral,
    claudexVoice: enAdminClaudexVoice,
    claudexFeedback: enAdminClaudexFeedback,
    claudexSharing: enAdminClaudexSharing,
    claudexGitHub: enAdminClaudexGitHub,
    claudexMemory: enAdminClaudexMemory,
    claudexWeb: enAdminClaudexWeb
  }
}

describe.each(Object.keys(roots))('locale %s spread assembly', (locale) => {
  it('root modules have no overlapping top-level keys', () => {
    expect(collisions(roots[locale])).toEqual([])
  })

  it('root modules do not shadow the explicit "admin" namespace', () => {
    for (const [name, mod] of Object.entries(roots[locale])) {
      expect(Object.keys(mod), `module ${name} must not define "admin"`).not.toContain('admin')
    }
  })

  it('admin modules have no overlapping top-level keys', () => {
    expect(collisions(admins[locale])).toEqual([])
  })
})
