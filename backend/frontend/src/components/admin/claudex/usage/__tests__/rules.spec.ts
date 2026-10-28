// CLAUDEX K3: form logic of the usage rules page.
import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import type { UsageRule } from '@/api/admin/claudex/usageRules'
import {
  DEFAULT_LABEL_KEY,
  WINDOW_PRESETS,
  emptyRuleForm,
  formToInput,
  formatUsd,
  groupRuleSections,
  ruleToForm,
  secondsToWindow,
  validateModelPattern,
  validateRuleForm,
  windowLabel,
  windowToSeconds,
  type RuleForm
} from '../rules'

function lookup(messages: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

function rule(overrides: Partial<UsageRule> = {}): UsageRule {
  return {
    id: 1,
    group_id: null,
    kind: 'session',
    label: 'Current session',
    model_patterns: ['*'],
    window_seconds: 18000,
    limit_usd: 5,
    enabled: true,
    show_in_client: true,
    sort_order: 0,
    ...overrides
  }
}

function form(overrides: Partial<RuleForm> = {}): RuleForm {
  return { ...emptyRuleForm(), label: 'Current session', limitUsd: 5, ...overrides }
}

describe('window presets', () => {
  it.each([
    ['5h', 18000],
    ['24h', 86400],
    ['7d', 604800],
    ['30d', 2592000]
  ] as const)('%s is %d seconds', (choice, seconds) => {
    expect(windowToSeconds(choice)).toBe(seconds)
    expect(secondsToWindow(seconds)).toEqual({ choice, customHours: null })
  })

  it('converts custom whole hours from 1 to 720', () => {
    expect(windowToSeconds('custom', 1)).toBe(3600)
    expect(windowToSeconds('custom', 36)).toBe(129600)
    expect(windowToSeconds('custom', '12')).toBe(43200)
    expect(windowToSeconds('custom', 720)).toBe(2592000)
  })

  it.each([0, -1, 721, 1.5, Number.NaN, null, '', ' ', 'abc'])('refuses custom hours %j', (hours) => {
    expect(windowToSeconds('custom', hours as never)).toBeNull()
  })

  it('reads windows that match no preset as custom hours', () => {
    expect(secondsToWindow(129600)).toEqual({ choice: 'custom', customHours: 36 })
    expect(secondsToWindow(3600)).toEqual({ choice: 'custom', customHours: 1 })
    // Not whole hours (stored some other way): shown as-is, the form then asks for whole hours.
    expect(secondsToWindow(5400)).toEqual({ choice: 'custom', customHours: 1.5 })
    expect(validateRuleForm(form({ windowChoice: 'custom', customHours: 1.5 })).window).toBeTruthy()
  })

  it('stays within the server bounds for every choice', () => {
    for (const preset of WINDOW_PRESETS) {
      expect(preset.seconds).toBeGreaterThanOrEqual(3600)
      expect(preset.seconds).toBeLessThanOrEqual(2592000)
    }
  })

  it('labels windows', () => {
    expect(windowLabel(18000)).toEqual({ key: 'admin.claudexUsageRules.window.5h' })
    expect(windowLabel(129600)).toEqual({ key: 'admin.claudexUsageRules.window.hours', params: { n: 36 } })
  })

  it('round-trips a stored rule through the form', () => {
    for (const seconds of [18000, 86400, 604800, 2592000, 7200, 129600]) {
      const stored = rule({ window_seconds: seconds })
      expect(formToInput(ruleToForm(stored)).window_seconds).toBe(seconds)
    }
  })
})

describe('model patterns', () => {
  it.each(['claude-opus-4', 'claude-opus-*', 'gpt-5.5', 'x'.repeat(200)])('accepts %s', (value) => {
    expect(validateModelPattern(value)).toBeNull()
  })

  it.each([
    ['', 'patternEmpty'],
    ['x'.repeat(201), 'patternTooLong'],
    ['claude opus', 'patternSpaces'],
    ['*', 'patternAll'],
    ['*-opus', 'patternWildcard'],
    ['claude-*-opus', 'patternWildcard'],
    ['claude-**', 'patternWildcard']
  ])('refuses %j', (value, problem) => {
    expect(validateModelPattern(value)).toBe(`admin.claudexUsageRules.validation.${problem}`)
  })
})

describe('validateRuleForm', () => {
  it('accepts a session rule', () => {
    expect(validateRuleForm(form())).toEqual({})
  })

  it('checks the label', () => {
    expect(validateRuleForm(form({ label: '  ' })).label).toBe('admin.claudexUsageRules.validation.labelRequired')
    expect(validateRuleForm(form({ label: 'x'.repeat(61) })).label).toBe(
      'admin.claudexUsageRules.validation.labelTooLong'
    )
    expect(validateRuleForm(form({ label: 'x'.repeat(60) })).label).toBeUndefined()
  })

  it('needs 1 to 50 valid, distinct patterns for specific models only', () => {
    expect(validateRuleForm(form({ kind: 'models', patterns: [] })).patterns).toBe(
      'admin.claudexUsageRules.validation.patternsRequired'
    )
    expect(validateRuleForm(form({ kind: 'models', patterns: Array.from({ length: 51 }, (_, i) => `m${i}`) })).patterns).toBe(
      'admin.claudexUsageRules.validation.patternsTooMany'
    )
    expect(validateRuleForm(form({ kind: 'models', patterns: ['claude opus'] })).patterns).toBe(
      'admin.claudexUsageRules.validation.patternSpaces'
    )
    expect(validateRuleForm(form({ kind: 'models', patterns: ['Claude-Opus-*', 'claude-opus-*'] })).patterns).toBe(
      'admin.claudexUsageRules.validation.patternDuplicate'
    )
    expect(validateRuleForm(form({ kind: 'models', patterns: ['claude-opus-*'] }))).toEqual({})
    expect(validateRuleForm(form({ kind: 'all_models', patterns: [] }))).toEqual({})
  })

  it('needs a limit above 0', () => {
    for (const bad of [null, '', 0, -1, 'abc', Number.POSITIVE_INFINITY, 2_000_000_000]) {
      expect(validateRuleForm(form({ limitUsd: bad as never })).limit, String(bad)).toBe(
        'admin.claudexUsageRules.validation.limit'
      )
    }
    expect(validateRuleForm(form({ limitUsd: 0.01 })).limit).toBeUndefined()
    expect(validateRuleForm(form({ limitUsd: '20' })).limit).toBeUndefined()
  })

  it('needs a whole sort order (empty is 0)', () => {
    expect(validateRuleForm(form({ sortOrder: 1.5 })).sort).toBe('admin.claudexUsageRules.validation.sort')
    expect(validateRuleForm(form({ sortOrder: '' })).sort).toBeUndefined()
    expect(formToInput(form({ sortOrder: '' })).sort_order).toBe(0)
    expect(formToInput(form({ sortOrder: '-3' })).sort_order).toBe(-3)
  })
})

describe('formToInput', () => {
  it('sends ["*"] for session and all models, and the trimmed patterns otherwise', () => {
    expect(formToInput(form({ patterns: ['ignored'] }))).toEqual({
      group_id: null,
      kind: 'session',
      label: 'Current session',
      model_patterns: ['*'],
      window_seconds: 18000,
      limit_usd: 5,
      enabled: true,
      show_in_client: true,
      sort_order: 0
    })
    expect(
      formToInput(
        form({
          groupId: 4,
          kind: 'models',
          label: ' Opus ',
          patterns: [' claude-opus-* '],
          windowChoice: '7d',
          limitUsd: '20',
          enabled: false,
          showInClient: false,
          sortOrder: 10
        })
      )
    ).toEqual({
      group_id: 4,
      kind: 'models',
      label: 'Opus',
      model_patterns: ['claude-opus-*'],
      window_seconds: 604800,
      limit_usd: 20,
      enabled: false,
      show_in_client: false,
      sort_order: 10
    })
    expect(formToInput(form({ windowChoice: 'custom', customHours: 36 })).window_seconds).toBe(129600)
  })

  it('refuses an invalid window', () => {
    expect(() => formToInput(form({ windowChoice: 'custom', customHours: 0 }))).toThrow()
  })
})

describe('groupRuleSections', () => {
  it('puts All groups first, then groups by name, rules by order then id', () => {
    const rules = [
      rule({ id: 5, group_id: 4, sort_order: 10, label: 'Opus' }),
      rule({ id: 3, group_id: 4, sort_order: 0 }),
      rule({ id: 7, group_id: 2, sort_order: 0 }),
      rule({ id: 9, group_id: null, sort_order: 1 }),
      rule({ id: 8, group_id: null, sort_order: 1 }),
      rule({ id: 6, group_id: 99, group_name: 'gone' })
    ]
    const names = new Map([
      [4, 'b-pro'],
      [2, 'a-basic']
    ])
    const sections = groupRuleSections(rules, names, 'All groups')
    expect(sections.map((s) => [s.groupId, s.groupName, s.rules.map((r) => r.id)])).toEqual([
      [null, 'All groups', [8, 9]],
      [2, 'a-basic', [7]],
      [4, 'b-pro', [3, 5]],
      [99, 'gone', [6]]
    ])
  })

  it('always has the All groups section', () => {
    expect(groupRuleSections([], new Map(), 'All groups')).toEqual([
      { groupId: null, groupName: 'All groups', groupDeleted: false, rules: [] }
    ])
  })

  it('marks the section of a deleted group (design 1.3)', () => {
    const sections = groupRuleSections(
      [rule({ id: 6, group_id: 99, group_name: 'gone', group_deleted: true }), rule({ id: 7, group_id: 4 })],
      new Map([[4, 'pro']]),
      'All groups'
    )
    expect(sections.map((s) => [s.groupId, s.groupName, s.groupDeleted])).toEqual([
      [null, 'All groups', false],
      [99, 'gone', true],
      [4, 'pro', false]
    ])
  })
})

describe('formatUsd', () => {
  it('formats dollars', () => {
    expect(formatUsd(20)).toBe('$20.00')
    expect(formatUsd('20.13')).toBe('$20.13')
    expect(formatUsd(0.0035)).toBe('$0.0035')
    expect(formatUsd(null)).toBe('$0.00')
  })
})

describe('message keys used by the rule form', () => {
  it('exist in English and Chinese', () => {
    const keys = [
      ...WINDOW_PRESETS.map((p) => `admin.claudexUsageRules.window.${p.id}`),
      'admin.claudexUsageRules.window.hours',
      'admin.claudexUsageRules.window.custom',
      ...Object.values(DEFAULT_LABEL_KEY).filter((k): k is string => !!k),
      ...['session', 'all_models', 'models'].flatMap((kind) => [
        `admin.claudexUsageRules.kinds.${kind}`,
        `admin.claudexUsageRules.kindHints.${kind}`
      ]),
      ...['rule', 'subscription', 'key'].map((s) => `admin.claudexUsageRules.status.sources.${s}`),
      'admin.claudexUsageRules.groupDeleted',
      'admin.claudexUsageRules.deletedGroupOption',
      'admin.claudexUsageRules.errors.CLAUDEX_NO_PLAN',
      ...[
        'kind',
        'labelRequired',
        'labelTooLong',
        'patternsRequired',
        'patternsTooMany',
        'patternEmpty',
        'patternTooLong',
        'patternSpaces',
        'patternAll',
        'patternWildcard',
        'patternDuplicate',
        'customHours',
        'limit',
        'sort'
      ].map((k) => `admin.claudexUsageRules.validation.${k}`)
    ]
    for (const key of keys) {
      expect(typeof lookup(en, key), `en ${key}`).toBe('string')
      expect(typeof lookup(zh, key), `zh ${key}`).toBe('string')
    }
  })
})
