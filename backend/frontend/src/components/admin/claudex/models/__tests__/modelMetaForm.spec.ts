// CLAUDEX: the model catalog form checks mirror design §2.4 / §3.2 (K2).
import { describe, expect, it } from 'vitest'

import type { ClaudexModelMeta } from '@/api/admin/claudex/models'
import {
  badgeProblemKey,
  charCount,
  effortsAboveCeiling,
  effortsInOrder,
  emptyModelMetaForm,
  fieldFromServer,
  formFromRow,
  readInteger,
  SORT_ORDER_LIMIT,
  TOKENS_MAX,
  toModelMetaInput,
  validateModelMetaForm,
  type ModelMetaForm
} from '../modelMetaForm'

const V = 'admin.claudexModels.validation'

function validForm(overrides: Partial<ModelMetaForm> = {}): ModelMetaForm {
  return {
    ...emptyModelMetaForm(),
    model_id: 'gpt-5.5',
    display_name: 'GPT-5.5',
    description: 'Our smartest model for complex work',
    badges: ['new'],
    sort_order: 10,
    is_default: true,
    efforts_known: true,
    supported_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_effort: 'medium',
    context_window: 400000,
    auto_compact_tokens: 320000,
    fast_tier: true,
    usage_hint: '1.5× usage',
    ...overrides
  }
}

function problemKeys(form: ModelMetaForm, groups?: Set<number>) {
  return Object.fromEntries(
    Object.entries(validateModelMetaForm(form, groups)).map(([field, problem]) => [field, problem?.key])
  )
}

const row: ClaudexModelMeta = {
  id: 7,
  model_id: 'gpt-5.5',
  group_id: 4,
  display_name: 'GPT-5.5',
  description: 'Our smartest model for complex work',
  badges: ['new'],
  sort_order: 10,
  hidden: false,
  is_default: true,
  supported_efforts: ['high', 'low', 'medium'],
  default_effort: 'medium',
  context_window: 400000,
  auto_compact_tokens: null,
  fast_tier: null,
  usage_hint: '',
  created_by: 1,
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z'
}

describe('validateModelMetaForm', () => {
  it('round-trips the minimum desktop version through the editor', () => {
    const form = formFromRow({ ...row, minimum_desktop_version: '1.2.3' })
    expect(toModelMetaInput(form).minimum_desktop_version).toBe('1.2.3')
    form.minimum_desktop_version = ''
    expect(toModelMetaInput(form).minimum_desktop_version).toBe('')
    expect(fieldFromServer('minimum_desktop_version')).toBe('minimum_desktop_version')
  })
  it('accepts the design example', () => {
    expect(validateModelMetaForm(validForm())).toEqual({})
  })

  it('accepts a bare entry: only a model ID, everything else unset', () => {
    expect(validateModelMetaForm({ ...emptyModelMetaForm(), model_id: 'gpt-5.5-mini' })).toEqual({})
  })

  it.each([
    ['', 'modelRequired'],
    ['   ', 'modelRequired'],
    ['m'.repeat(201), 'tooLong'],
    ['gpt 5', 'modelCharacters'],
    ['gpt-*', 'modelCharacters'],
    ['gpt\u00075', 'modelCharacters']
  ])('model ID %j -> %s', (modelId, rule) => {
    expect(problemKeys(validForm({ model_id: modelId })).model_id).toBe(`${V}.${rule}`)
  })

  it('trims the model ID before checking it', () => {
    expect(problemKeys(validForm({ model_id: '  gpt-5.5 ' })).model_id).toBeUndefined()
  })

  it('rejects control characters in text, allowing line breaks only in the description', () => {
    expect(problemKeys(validForm({ display_name: 'GPT\u0000' })).display_name).toBe(`${V}.invalidCharacters`)
    expect(problemKeys(validForm({ usage_hint: '1.5\u001b×' })).usage_hint).toBe(`${V}.invalidCharacters`)
    expect(problemKeys(validForm({ description: 'Line one\nLine\ttwo' })).description).toBeUndefined()
    expect(problemKeys(validForm({ description: 'Bell\u0007' })).description).toBe(`${V}.invalidCharacters`)
  })

  it('allows a model ID of exactly 200 characters, counted as characters', () => {
    expect(problemKeys(validForm({ model_id: 'm'.repeat(200) })).model_id).toBeUndefined()
    // 200 emoji are 400 UTF-16 units but 200 characters.
    expect(problemKeys(validForm({ model_id: '😀'.repeat(200) })).model_id).toBeUndefined()
    expect(problemKeys(validForm({ model_id: '😀'.repeat(201) })).model_id).toBe(`${V}.tooLong`)
  })

  it.each([
    ['display_name', 100],
    ['description', 500],
    ['usage_hint', 40]
  ] as const)('%s allows %i characters and no more', (field, max) => {
    expect(problemKeys(validForm({ [field]: 'a'.repeat(max) }))[field]).toBeUndefined()
    const problem = validateModelMetaForm(validForm({ [field]: 'a'.repeat(max + 1) }))[field]
    expect(problem).toEqual({ key: `${V}.tooLong`, params: { max } })
  })

  it('checks the group against the known groups', () => {
    const groups = new Set([4])
    expect(problemKeys(validForm({ group_id: 4 }), groups).group_id).toBeUndefined()
    expect(problemKeys(validForm({ group_id: null }), groups).group_id).toBeUndefined()
    expect(problemKeys(validForm({ group_id: 9 }), groups).group_id).toBe(`${V}.groupUnknown`)
  })

  it('allows at most 3 badges that match the badge pattern', () => {
    expect(problemKeys(validForm({ badges: ['new', 'beta', '1.5× usage'] })).badges).toBeUndefined()
    expect(problemKeys(validForm({ badges: ['a', 'b', 'c', 'd'] })).badges).toBe(`${V}.badgesLimit`)
    expect(problemKeys(validForm({ badges: ['new!'] })).badges).toBe(`${V}.badgeFormat`)
    expect(problemKeys(validForm({ badges: ['x'.repeat(17)] })).badges).toBe(`${V}.badgeFormat`)
    expect(problemKeys(validForm({ badges: ['New', 'new'] })).badges).toBe(`${V}.badgeDuplicate`)
  })

  it.each([
    ['new', null],
    ['GPT-5 +', null],
    ['2×', null],
    ['x'.repeat(16), null],
    ['', `${V}.badgeFormat`],
    ['x'.repeat(17), `${V}.badgeFormat`],
    ['new!', `${V}.badgeFormat`],
    ['新', `${V}.badgeFormat`],
    ['a_b', `${V}.badgeFormat`]
  ])('badge %j -> %j', (badge, problem) => {
    expect(badgeProblemKey(badge)).toBe(problem)
  })

  it.each([
    [0, undefined],
    [-5, undefined],
    ['12', undefined],
    [SORT_ORDER_LIMIT, undefined],
    [-SORT_ORDER_LIMIT, undefined],
    ['', `${V}.integerRequired`],
    ['1.5', `${V}.integer`],
    [1.5, `${V}.integer`],
    ['abc', `${V}.integer`],
    [SORT_ORDER_LIMIT + 1, `${V}.integerRange`],
    [-SORT_ORDER_LIMIT - 1, `${V}.integerRange`],
    ['99999999999999999999', `${V}.integerRange`]
  ])('sort order %j -> %j', (value, key) => {
    expect(problemKeys(validForm({ sort_order: value })).sort_order).toBe(key)
  })

  it('needs at least one effort unless efforts are not known', () => {
    expect(problemKeys(validForm({ supported_efforts: [], default_effort: '' })).supported_efforts).toBe(
      `${V}.effortsRequired`
    )
    expect(
      problemKeys(validForm({ efforts_known: false, supported_efforts: [], default_effort: '' })).supported_efforts
    ).toBeUndefined()
    expect(problemKeys(validForm({ supported_efforts: ['none'], default_effort: 'none' }))).toEqual({})
  })

  it('rejects an effort outside the vocabulary', () => {
    const form = validForm({ supported_efforts: ['low', 'ultra' as never], default_effort: '' })
    expect(problemKeys(form).supported_efforts).toBe(`${V}.effortUnknown`)
  })

  it('needs the default effort to be one of the supported efforts', () => {
    expect(problemKeys(validForm({ default_effort: 'max' })).default_effort).toBe(`${V}.defaultEffortNotSupported`)
    expect(problemKeys(validForm({ default_effort: '' })).default_effort).toBeUndefined()
    expect(
      problemKeys(validForm({ efforts_known: false, supported_efforts: [], default_effort: 'low' })).default_effort
    ).toBe(`${V}.defaultEffortNotSupported`)
  })

  it.each([
    ['', undefined],
    [1, undefined],
    [TOKENS_MAX, undefined],
    [0, `${V}.positiveInteger`],
    [-1, `${V}.positiveInteger`],
    ['1e3', `${V}.positiveInteger`],
    [2.5, `${V}.positiveInteger`],
    [TOKENS_MAX + 1, `${V}.integerRange`]
  ])('context window %j -> %j', (value, key) => {
    expect(problemKeys(validForm({ context_window: value, auto_compact_tokens: '' })).context_window).toBe(key)
  })

  it('needs auto-compact below the context window', () => {
    expect(
      problemKeys(validForm({ context_window: 1000, auto_compact_tokens: 999 })).auto_compact_tokens
    ).toBeUndefined()
    expect(problemKeys(validForm({ context_window: 1000, auto_compact_tokens: 1000 })).auto_compact_tokens).toBe(
      `${V}.autoCompactBelowContext`
    )
    expect(problemKeys(validForm({ context_window: 1000, auto_compact_tokens: 5000 })).auto_compact_tokens).toBe(
      `${V}.autoCompactBelowContext`
    )
    // Without a context window only "positive whole number" applies.
    expect(
      problemKeys(validForm({ context_window: '', auto_compact_tokens: 5000 })).auto_compact_tokens
    ).toBeUndefined()
    expect(problemKeys(validForm({ context_window: '', auto_compact_tokens: 0 })).auto_compact_tokens).toBe(
      `${V}.positiveInteger`
    )
  })
})

describe('toModelMetaInput', () => {
  it('builds the design example body', () => {
    expect(toModelMetaInput(validForm())).toEqual({
      model_id: 'gpt-5.5',
      group_id: null,
      display_name: 'GPT-5.5',
      description: 'Our smartest model for complex work',
      badges: ['new'],
      sort_order: 10,
      hidden: false,
      is_default: true,
      supported_efforts: ['low', 'medium', 'high', 'xhigh'],
      default_effort: 'medium',
      context_window: 400000,
      auto_compact_tokens: 320000,
      fast_tier: true,
      usage_hint: '1.5× usage'
    })
  })

  it('sends unknown and unset values as null and trims text', () => {
    const body = toModelMetaInput({
      ...emptyModelMetaForm(4),
      model_id: '  gpt-5.5-mini ',
      display_name: ' Mini ',
      sort_order: '20',
      context_window: '',
      auto_compact_tokens: '  ',
      fast_tier: false
    })
    expect(body).toMatchObject({
      model_id: 'gpt-5.5-mini',
      group_id: 4,
      display_name: 'Mini',
      sort_order: 20,
      supported_efforts: null,
      default_effort: '',
      context_window: null,
      auto_compact_tokens: null,
      fast_tier: false
    })
    expect(toModelMetaInput({ ...emptyModelMetaForm(), model_id: 'm' }).fast_tier).toBeNull()
  })

  it('sends efforts lowest first and drops the default when efforts are not known', () => {
    expect(
      toModelMetaInput(validForm({ supported_efforts: ['max', 'none', 'low'], default_effort: 'low' }))
        .supported_efforts
    ).toEqual(['none', 'low', 'max'])
    const unknown = toModelMetaInput(validForm({ efforts_known: false, default_effort: 'low' }))
    expect(unknown.supported_efforts).toBeNull()
    expect(unknown.default_effort).toBe('')
  })
})

describe('formFromRow', () => {
  it('round-trips a saved row', () => {
    const form = formFromRow(row)
    expect(form.efforts_known).toBe(true)
    expect(form.supported_efforts).toEqual(['low', 'medium', 'high'])
    expect(form.fast_tier).toBeNull()
    expect(form.auto_compact_tokens).toBe('')
    const body = toModelMetaInput(form)
    expect(body).toMatchObject({
      model_id: 'gpt-5.5',
      group_id: 4,
      supported_efforts: ['low', 'medium', 'high'],
      default_effort: 'medium',
      context_window: 400000,
      auto_compact_tokens: null,
      fast_tier: null,
      is_default: true
    })
  })

  it('reads unknown efforts and keeps a stored fast tier as it is (R6: no Fast field)', () => {
    const form = formFromRow({ ...row, supported_efforts: null, default_effort: '', fast_tier: false })
    expect(form.efforts_known).toBe(false)
    expect(form.supported_efforts).toEqual([])
    expect(form.fast_tier).toBe(false)
    expect(toModelMetaInput(form).fast_tier).toBe(false)
  })
})

describe('helpers', () => {
  it('counts characters, not UTF-16 units', () => {
    expect(charCount('abc')).toBe(3)
    expect(charCount('1.5×')).toBe(4)
    expect(charCount('😀😀')).toBe(2)
  })

  it('reads whole numbers', () => {
    expect(readInteger('')).toBeNull()
    expect(readInteger(null)).toBeNull()
    expect(readInteger(Number.NaN)).toBeNull()
    expect(readInteger(' 42 ')).toBe(42)
    expect(readInteger('-3')).toBe(-3)
    expect(readInteger('4.0')).toBe('invalid')
    expect(readInteger(7)).toBe(7)
    expect(readInteger(7.5)).toBe('invalid')
  })

  it('orders efforts and finds those above a group ceiling', () => {
    expect(effortsInOrder(['high', 'none', 'high', 'ultra'])).toEqual(['none', 'high'])
    expect(effortsAboveCeiling(['low', 'medium', 'high', 'xhigh'], 'medium')).toEqual(['high', 'xhigh'])
    expect(effortsAboveCeiling(['low', 'max'], '')).toEqual([])
    expect(effortsAboveCeiling(['low', 'max'], undefined)).toEqual([])
    expect(effortsAboveCeiling(['low', 'max'], 'unlimited')).toEqual([])
  })

  it('maps a server field name to a form field', () => {
    expect(fieldFromServer('context_window')).toBe('context_window')
    expect(fieldFromServer('badges[1]')).toBe('badges')
    expect(fieldFromServer('badges.0')).toBe('badges')
    expect(fieldFromServer('unknown')).toBeNull()
    expect(fieldFromServer(undefined)).toBeNull()
  })
})
