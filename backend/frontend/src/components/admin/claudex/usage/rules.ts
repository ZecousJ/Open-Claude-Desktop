/**
 * CLAUDEX: form logic of the usage rules page (/admin/claudex/usage-rules):
 * window presets and their seconds, the rule form and its checks, and the
 * grouping of rules into per-group sections. The server (B5) validates again
 * and is authoritative; these checks mirror design 2.6.
 */

import type { UsageRule, UsageRuleInput, UsageRuleKind } from '@/api/admin/claudex/usageRules'

export const HOUR_SECONDS = 3600

/** Window choices offered by the editor ("custom" = whole hours). */
export const WINDOW_PRESETS = [
  { id: '5h', seconds: 5 * HOUR_SECONDS },
  { id: '24h', seconds: 24 * HOUR_SECONDS },
  { id: '7d', seconds: 7 * 24 * HOUR_SECONDS },
  { id: '30d', seconds: 30 * 24 * HOUR_SECONDS }
] as const

export type WindowPresetId = (typeof WINDOW_PRESETS)[number]['id']
export type WindowChoice = WindowPresetId | 'custom'

export const CUSTOM_HOURS_MIN = 1
export const CUSTOM_HOURS_MAX = 720
/** The server's bounds (claudex_usage_rules.window_seconds). */
export const WINDOW_SECONDS_MIN = CUSTOM_HOURS_MIN * HOUR_SECONDS
export const WINDOW_SECONDS_MAX = CUSTOM_HOURS_MAX * HOUR_SECONDS

export const LABEL_MAX = 60
export const PATTERNS_MAX = 50
export const PATTERN_MAX_LENGTH = 200
/** NUMERIC(20,8) on the server; keep far below it. */
export const LIMIT_USD_MAX = 1_000_000_000
export const SORT_MIN = -1_000_000
export const SORT_MAX = 1_000_000

/** Default window of each kind when a new rule picks it. */
export const DEFAULT_WINDOW_BY_KIND: Record<UsageRuleKind, WindowPresetId> = {
  session: '5h',
  all_models: '7d',
  models: '7d'
}

/**
 * Seconds of a window choice; null when a custom value is not a whole number
 * of hours from 1 to 720.
 */
export function windowToSeconds(choice: WindowChoice, customHours?: number | string | null): number | null {
  if (choice !== 'custom') {
    return WINDOW_PRESETS.find((preset) => preset.id === choice)?.seconds ?? null
  }
  const raw = typeof customHours === 'string' ? customHours.trim() : customHours
  if (raw === null || raw === undefined || raw === '') return null
  const hours = Number(raw)
  if (!Number.isInteger(hours) || hours < CUSTOM_HOURS_MIN || hours > CUSTOM_HOURS_MAX) return null
  return hours * HOUR_SECONDS
}

/**
 * The editor state for a stored window: a preset when the seconds match one,
 * otherwise custom hours (fractional when the rule was stored with a window
 * that is not whole hours; the form then asks for whole hours).
 */
export function secondsToWindow(seconds: number): { choice: WindowChoice; customHours: number | null } {
  const preset = WINDOW_PRESETS.find((p) => p.seconds === seconds)
  if (preset) return { choice: preset.id, customHours: null }
  return { choice: 'custom', customHours: seconds / HOUR_SECONDS }
}

/** i18n key and params that describe a window, e.g. "5 hours" or "36 hours". */
export function windowLabel(seconds: number): { key: string; params?: Record<string, unknown> } {
  const preset = WINDOW_PRESETS.find((p) => p.seconds === seconds)
  if (preset) return { key: `admin.claudexUsageRules.window.${preset.id}` }
  const hours = Math.round((seconds / HOUR_SECONDS) * 100) / 100
  return { key: 'admin.claudexUsageRules.window.hours', params: { n: hours } }
}

/** A USD amount such as "$20.00" or "$0.0035" (the API sends numbers; tolerate numeric strings). */
export function formatUsd(value: number | string | null | undefined): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return String(value ?? '')
  const tiny = n !== 0 && Math.abs(n) < 0.01
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: tiny ? 6 : 4
  })
}

/**
 * Checks one model pattern: an exact model name or a prefix ending in a single
 * `*`, no spaces, at most 200 characters. A lone `*` is refused (that is the
 * "All models" kind). Returns an i18n key or null.
 */
export function validateModelPattern(value: string): string | null {
  const text = value.trim()
  if (!text) return 'admin.claudexUsageRules.validation.patternEmpty'
  if (text.length > PATTERN_MAX_LENGTH) return 'admin.claudexUsageRules.validation.patternTooLong'
  if (/\s/.test(text)) return 'admin.claudexUsageRules.validation.patternSpaces'
  if (text === '*') return 'admin.claudexUsageRules.validation.patternAll'
  const star = text.indexOf('*')
  if (star !== -1 && star !== text.length - 1) return 'admin.claudexUsageRules.validation.patternWildcard'
  return null
}

export interface RuleForm {
  groupId: number | null
  kind: UsageRuleKind
  label: string
  patterns: string[]
  windowChoice: WindowChoice
  customHours: number | string | null
  limitUsd: number | string | null
  enabled: boolean
  showInClient: boolean
  sortOrder: number | string | null
}

export type RuleField = 'group' | 'kind' | 'label' | 'patterns' | 'window' | 'limit' | 'sort'
export type RuleErrors = Partial<Record<RuleField, string>>

/** Default label a new rule gets when its kind is chosen and the label is empty. */
export const DEFAULT_LABEL_KEY: Record<UsageRuleKind, string | null> = {
  session: 'admin.claudexUsageRules.defaults.sessionLabel',
  all_models: 'admin.claudexUsageRules.defaults.allModelsLabel',
  models: null
}

export function emptyRuleForm(groupId: number | null = null): RuleForm {
  return {
    groupId,
    kind: 'session',
    label: '',
    patterns: [],
    windowChoice: DEFAULT_WINDOW_BY_KIND.session,
    customHours: null,
    limitUsd: null,
    enabled: true,
    showInClient: true,
    sortOrder: 0
  }
}

export function ruleToForm(rule: UsageRule): RuleForm {
  const window = secondsToWindow(rule.window_seconds)
  return {
    groupId: rule.group_id ?? null,
    kind: rule.kind,
    label: rule.label ?? '',
    patterns: rule.kind === 'models' ? [...(rule.model_patterns ?? [])] : [],
    windowChoice: window.choice,
    customHours: window.customHours,
    limitUsd: Number(rule.limit_usd),
    enabled: rule.enabled,
    showInClient: rule.show_in_client,
    sortOrder: rule.sort_order ?? 0
  }
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    return Number(value.trim())
  }
  return value
}

/** Field problems of the form as i18n keys (empty object = valid). */
export function validateRuleForm(form: RuleForm): RuleErrors {
  const errors: RuleErrors = {}
  if (!['session', 'all_models', 'models'].includes(form.kind)) {
    errors.kind = 'admin.claudexUsageRules.validation.kind'
  }
  const label = form.label.trim()
  if (!label) errors.label = 'admin.claudexUsageRules.validation.labelRequired'
  else if ([...label].length > LABEL_MAX) errors.label = 'admin.claudexUsageRules.validation.labelTooLong'

  if (form.kind === 'models') {
    if (form.patterns.length === 0) errors.patterns = 'admin.claudexUsageRules.validation.patternsRequired'
    else if (form.patterns.length > PATTERNS_MAX) errors.patterns = 'admin.claudexUsageRules.validation.patternsTooMany'
    else {
      const bad = form.patterns.map(validateModelPattern).find((problem) => problem)
      if (bad) errors.patterns = bad
      const lowered = form.patterns.map((p) => p.trim().toLowerCase())
      if (!bad && new Set(lowered).size !== lowered.length) {
        errors.patterns = 'admin.claudexUsageRules.validation.patternDuplicate'
      }
    }
  }

  if (windowToSeconds(form.windowChoice, form.customHours) === null) {
    errors.window = 'admin.claudexUsageRules.validation.customHours'
  }

  const limit = toNumber(form.limitUsd)
  if (limit === null || !Number.isFinite(limit) || limit <= 0 || limit > LIMIT_USD_MAX) {
    errors.limit = 'admin.claudexUsageRules.validation.limit'
  }

  const sort = toNumber(form.sortOrder)
  if (sort !== null && (!Number.isInteger(sort) || sort < SORT_MIN || sort > SORT_MAX)) {
    errors.sort = 'admin.claudexUsageRules.validation.sort'
  }
  return errors
}

/** The request body for a valid form (call validateRuleForm first). */
export function formToInput(form: RuleForm): UsageRuleInput {
  const seconds = windowToSeconds(form.windowChoice, form.customHours)
  if (seconds === null) throw new Error('invalid usage rule window')
  return {
    group_id: form.groupId ?? null,
    kind: form.kind,
    label: form.label.trim(),
    model_patterns: form.kind === 'models' ? form.patterns.map((p) => p.trim()) : ['*'],
    window_seconds: seconds,
    limit_usd: Number(toNumber(form.limitUsd)),
    enabled: form.enabled,
    show_in_client: form.showInClient,
    sort_order: toNumber(form.sortOrder) ?? 0
  }
}

export interface RuleSection {
  /** null = the "All groups" section. */
  groupId: number | null
  groupName: string
  /** The group was deleted; its rules no longer apply (the page marks it "Deleted"). */
  groupDeleted: boolean
  rules: UsageRule[]
}

/**
 * Rules in sections: "All groups" first (always present), then one section per
 * group that has rules, by group name. Rules inside a section by sort order,
 * then id.
 */
export function groupRuleSections(
  rules: UsageRule[],
  groupNames: Map<number, string>,
  allGroupsLabel: string
): RuleSection[] {
  const byGroup = new Map<number | null, UsageRule[]>([[null, []]])
  for (const rule of rules) {
    const key = rule.group_id ?? null
    const list = byGroup.get(key) ?? []
    list.push(rule)
    byGroup.set(key, list)
  }
  const sections: RuleSection[] = [...byGroup.entries()].map(([groupId, list]) => ({
    groupId,
    groupName:
      groupId === null
        ? allGroupsLabel
        : groupNames.get(groupId) ?? list.find((r) => r.group_name)?.group_name ?? `#${groupId}`,
    groupDeleted: groupId !== null && list.some((r) => r.group_deleted === true),
    rules: [...list].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
  }))
  const [all, ...rest] = sections
  rest.sort((a, b) => a.groupName.localeCompare(b.groupName) || Number(a.groupId) - Number(b.groupId))
  return [all, ...rest]
}
