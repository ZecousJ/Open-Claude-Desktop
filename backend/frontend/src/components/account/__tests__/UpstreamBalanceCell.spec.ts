import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UpstreamBalanceCell from '../UpstreamBalanceCell.vue'
import type { Account } from '@/types'

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${Object.values(params).join(',')}` : key
    })
  }
})

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: 1,
  name: 'upstream',
  platform: 'openai',
  type: 'apikey',
  proxy_id: null,
  concurrency: 1,
  priority: 1,
  status: 'active',
  error_message: null,
  last_used_at: null,
  expires_at: null,
  auto_pause_on_expired: false,
  created_at: '2026-07-13T00:00:00Z',
  updated_at: '2026-07-13T00:00:00Z',
  schedulable: true,
  rate_limited_at: null,
  rate_limit_reset_at: null,
  overload_until: null,
  temp_unschedulable_until: null,
  temp_unschedulable_reason: null,
  session_window_start: null,
  session_window_end: null,
  session_window_status: null,
  ...overrides
})

const now = Date.parse('2026-10-11T05:00:00Z')
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  status: 'ok' as const,
  data: {
    object: 'sub2api.key_billing' as const,
    schema_version: 1 as const,
    billing_scope: 'token' as const,
    group_rate_multiplier: 0.25,
    resolved_rate_multiplier: 0.25,
    peak_rate_enabled: false,
    effective_rate_multiplier: 0.25,
    observed_at: '2026-10-11T04:50:00Z',
    wallet_balance: 1104.887619
  },
  received_at: '2026-10-11T04:50:00Z',
  fresh_until: '2026-10-11T05:30:00Z',
  last_attempt_at: '2026-10-11T04:50:00Z',
  next_probe_at: '2026-10-11T05:05:00Z',
  ...overrides
})

const render = (account: Account) =>
  mount(UpstreamBalanceCell, {
    props: { account, now },
    global: { stubs: { HelpTooltip: { template: '<div><slot name="trigger" /><slot /></div>' } } }
  })

describe('UpstreamBalanceCell', () => {
  it('shows the probed upstream wallet in dollars', () => {
    const wrapper = render(makeAccount({ extra: { upstream_billing_probe: snapshot() } }))
    expect(wrapper.get('[data-testid="upstream-balance"]').text()).toBe('$1,104.89')
    expect(wrapper.find('[data-testid="upstream-balance-stale"]').exists()).toBe(false)
  })

  it('greys out a balance whose probe is past its fresh window', () => {
    const wrapper = render(
      makeAccount({ extra: { upstream_billing_probe: snapshot({ fresh_until: '2026-10-11T04:55:00Z' }) } })
    )
    expect(wrapper.get('[data-testid="upstream-balance"]').classes()).toContain('text-gray-400')
    expect(wrapper.find('[data-testid="upstream-balance-stale"]').exists()).toBe(true)
  })

  it('shows a dash without a balance or for non API-key accounts', () => {
    const missing = snapshot()
    delete (missing.data as Record<string, unknown>).wallet_balance
    expect(render(makeAccount({ extra: { upstream_billing_probe: missing } })).find('[data-testid="upstream-balance-empty"]').exists()).toBe(true)
    expect(render(makeAccount()).find('[data-testid="upstream-balance-empty"]').exists()).toBe(true)
    expect(
      render(makeAccount({ type: 'oauth', extra: { upstream_billing_probe: snapshot() } }))
        .find('[data-testid="upstream-balance-empty"]').exists()
    ).toBe(true)
  })
})
