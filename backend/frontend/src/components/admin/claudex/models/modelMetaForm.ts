/**
 * CLAUDEX: the model catalog editor's form (K2): defaults, conversion from and
 * to the API body, and the checks of design §2.4 / §3.2. The server checks
 * again and is authoritative; these catch mistakes before saving.
 */

import {
  CLAUDEX_MODEL_EFFORTS,
  type ClaudexModelEffort,
  type ClaudexModelMeta,
  type ClaudexModelMetaInput
} from '@/api/admin/claudex/models'

export const MODEL_ID_MAX = 200
export const DISPLAY_NAME_MAX = 100
export const DESCRIPTION_MAX = 500
export const BADGES_MAX = 3
export const BADGE_MAX_LENGTH = 16
/** Badge text the desktop app accepts (design §2.4). */
export const BADGE_PATTERN = /^[A-Za-z0-9 .×x+-]{1,16}$/
export const USAGE_HINT_MAX = 40
/** Sort order range the catalog service accepts (-1,000,000 to 1,000,000). */
export const SORT_ORDER_LIMIT = 1_000_000
/** Largest context window or auto-compact threshold the catalog service accepts. */
export const TOKENS_MAX = 100_000_000

/**
 * Editor state. Number fields hold what the input holds (a number, or text
 * when empty or not a number) so an empty field can mean "not set".
 */
export interface ModelMetaForm {
  model_id: string
  group_id: number | null
  display_name: string
  description: string
  badges: string[]
  sort_order: string | number
  hidden: boolean
  is_default: boolean
  /** false = supported efforts not known (sent as null). */
  efforts_known: boolean
  supported_efforts: ClaudexModelEffort[]
  default_effort: ClaudexModelEffort | ''
  context_window: string | number
  auto_compact_tokens: string | number
  /**
   * Fast mode was dropped (R6): the console has no field for it. The stored
   * value is sent back unchanged so saving an entry does not rewrite it.
   */
  fast_tier: boolean | null
  usage_hint: string
  minimum_desktop_version?: string
}

export type ModelMetaField = keyof ClaudexModelMetaInput

/** A problem with one field: an i18n key under admin.claudexModels.validation and its parameters. */
export interface FieldProblem {
  key: string
  params?: Record<string, unknown>
}

export type ModelMetaProblems = Partial<Record<ModelMetaField, FieldProblem>>

const VALIDATION = 'admin.claudexModels.validation'

export function emptyModelMetaForm(groupId: number | null = null): ModelMetaForm {
  return {
    model_id: '',
    group_id: groupId,
    display_name: '',
    description: '',
    badges: [],
    sort_order: 0,
    hidden: false,
    is_default: false,
    efforts_known: false,
    supported_efforts: [],
    default_effort: '',
    context_window: '',
    auto_compact_tokens: '',
    fast_tier: null,
    usage_hint: ''
  }
}

export function formFromRow(row: ClaudexModelMeta): ModelMetaForm {
  const efforts = row.supported_efforts
  return {
    model_id: row.model_id,
    group_id: row.group_id ?? null,
    display_name: row.display_name ?? '',
    description: row.description ?? '',
    badges: [...(row.badges ?? [])],
    sort_order: row.sort_order ?? 0,
    hidden: !!row.hidden,
    is_default: !!row.is_default,
    efforts_known: Array.isArray(efforts),
    supported_efforts: Array.isArray(efforts) ? effortsInOrder(efforts) : [],
    default_effort: row.default_effort ?? '',
    context_window: row.context_window ?? '',
    auto_compact_tokens: row.auto_compact_tokens ?? '',
    fast_tier: typeof row.fast_tier === 'boolean' ? row.fast_tier : null,
    usage_hint: row.usage_hint ?? '',
    minimum_desktop_version: row.minimum_desktop_version ?? ''
  }
}

/** Length in characters (code points), as the server counts it. */
export function charCount(value: string): number {
  return Array.from(value).length
}

export function isEffort(value: unknown): value is ClaudexModelEffort {
  return typeof value === 'string' && (CLAUDEX_MODEL_EFFORTS as readonly string[]).includes(value)
}

/** The given efforts without duplicates, lowest first. */
export function effortsInOrder(values: readonly string[]): ClaudexModelEffort[] {
  return CLAUDEX_MODEL_EFFORTS.filter((effort) => values.includes(effort))
}

/**
 * Efforts above a group's max_reasoning_effort; the server drops these for
 * that group's users. An empty or unknown ceiling drops nothing.
 */
export function effortsAboveCeiling(
  efforts: readonly ClaudexModelEffort[],
  ceiling: string | null | undefined
): ClaudexModelEffort[] {
  if (!isEffort(ceiling)) return []
  const limit = CLAUDEX_MODEL_EFFORTS.indexOf(ceiling)
  return efforts.filter((effort) => CLAUDEX_MODEL_EFFORTS.indexOf(effort) > limit)
}

/**
 * Reads a whole-number field: null when empty, 'invalid' when it is not a
 * whole number.
 */
export function readInteger(raw: unknown): number | null | 'invalid' {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) return null
    return Number.isInteger(raw) ? raw : 'invalid'
  }
  const text = String(raw).trim()
  if (!text) return null
  // Out-of-range whole numbers stay numbers so the caller reports the range.
  return /^[+-]?\d+$/.test(text) ? Number(text) : 'invalid'
}

/** i18n key for a badge the catalog does not accept (TagInput `validate`). */
export function badgeProblemKey(value: string): string | null {
  return BADGE_PATTERN.test(value) ? null : `${VALIDATION}.badgeFormat`
}

function tooLong(value: string, max: number): FieldProblem | null {
  return charCount(value) > max ? { key: `${VALIDATION}.tooLong`, params: { max } } : null
}

/** Control characters (line breaks and tabs are allowed where `multiline`). */
function hasControlCharacters(value: string, multiline = false): boolean {
  for (const char of value) {
    if (multiline && (char === '\n' || char === '\t')) continue
    if (/\p{Cc}/u.test(char)) return true
  }
  return false
}

function text(value: string, max: number, multiline = false): FieldProblem | null {
  const trimmed = value.trim()
  if (hasControlCharacters(trimmed, multiline)) return { key: `${VALIDATION}.invalidCharacters` }
  return tooLong(trimmed, max)
}

function tokenCount(raw: unknown): { value: number | null; problem: FieldProblem | null } {
  const value = readInteger(raw)
  if (value === null) return { value: null, problem: null }
  if (value === 'invalid' || value < 1) {
    return { value: null, problem: { key: `${VALIDATION}.positiveInteger` } }
  }
  if (value > TOKENS_MAX) {
    return { value: null, problem: { key: `${VALIDATION}.integerRange`, params: { min: 1, max: TOKENS_MAX } } }
  }
  return { value, problem: null }
}

/**
 * Checks the form. `groupIds` (when given) are the groups a new row may be
 * scoped to. Returns one problem per field; an empty object means valid.
 */
export function validateModelMetaForm(form: ModelMetaForm, groupIds?: ReadonlySet<number>): ModelMetaProblems {
  const problems: ModelMetaProblems = {}
  const set = (field: ModelMetaField, problem: FieldProblem | null) => {
    if (problem && !problems[field]) problems[field] = problem
  }

  const modelId = form.model_id.trim()
  if (!modelId) set('model_id', { key: `${VALIDATION}.modelRequired` })
  // An exact model name: no spaces, control characters or wildcards.
  else if (/[\s*]|\p{Cc}/u.test(modelId)) set('model_id', { key: `${VALIDATION}.modelCharacters` })
  else set('model_id', tooLong(modelId, MODEL_ID_MAX))

  if (form.group_id !== null && groupIds && !groupIds.has(form.group_id)) {
    set('group_id', { key: `${VALIDATION}.groupUnknown` })
  }

  set('display_name', text(form.display_name, DISPLAY_NAME_MAX))
  set('description', text(form.description, DESCRIPTION_MAX, true))

  const badges = form.badges.map((badge) => badge.trim())
  if (badges.length > BADGES_MAX) {
    set('badges', { key: `${VALIDATION}.badgesLimit`, params: { max: BADGES_MAX } })
  } else if (badges.some((badge) => badgeProblemKey(badge) !== null)) {
    set('badges', { key: `${VALIDATION}.badgeFormat` })
  } else if (new Set(badges.map((badge) => badge.toLowerCase())).size !== badges.length) {
    set('badges', { key: `${VALIDATION}.badgeDuplicate` })
  }

  const sort = readInteger(form.sort_order)
  if (sort === null) set('sort_order', { key: `${VALIDATION}.integerRequired` })
  else if (sort === 'invalid') set('sort_order', { key: `${VALIDATION}.integer` })
  else if (sort < -SORT_ORDER_LIMIT || sort > SORT_ORDER_LIMIT) {
    set('sort_order', { key: `${VALIDATION}.integerRange`, params: { min: -SORT_ORDER_LIMIT, max: SORT_ORDER_LIMIT } })
  }

  if (form.efforts_known) {
    if (form.supported_efforts.length === 0) set('supported_efforts', { key: `${VALIDATION}.effortsRequired` })
    else if (!form.supported_efforts.every(isEffort)) set('supported_efforts', { key: `${VALIDATION}.effortUnknown` })
  }
  if (form.default_effort) {
    const allowed = form.efforts_known ? form.supported_efforts : []
    if (!allowed.includes(form.default_effort)) {
      set('default_effort', { key: `${VALIDATION}.defaultEffortNotSupported` })
    }
  }

  const context = tokenCount(form.context_window)
  set('context_window', context.problem)
  const compact = tokenCount(form.auto_compact_tokens)
  set('auto_compact_tokens', compact.problem)
  if (!compact.problem && compact.value !== null && context.value !== null && compact.value >= context.value) {
    set('auto_compact_tokens', { key: `${VALIDATION}.autoCompactBelowContext` })
  }

  set('usage_hint', text(form.usage_hint, USAGE_HINT_MAX))
  return problems
}

/** The API body for a form that passed validateModelMetaForm. */
export function toModelMetaInput(form: ModelMetaForm): ClaudexModelMetaInput {
  const integerOrNull = (raw: unknown) => {
    const value = readInteger(raw)
    return typeof value === 'number' ? value : null
  }
  const supported = form.efforts_known ? effortsInOrder(form.supported_efforts) : null
  return {
    model_id: form.model_id.trim(),
    group_id: form.group_id,
    display_name: form.display_name.trim(),
    description: form.description.trim(),
    badges: form.badges.map((badge) => badge.trim()),
    sort_order: integerOrNull(form.sort_order) ?? 0,
    hidden: form.hidden,
    is_default: form.is_default,
    supported_efforts: supported,
    default_effort:
      supported && form.default_effort && supported.includes(form.default_effort) ? form.default_effort : '',
    context_window: integerOrNull(form.context_window),
    auto_compact_tokens: integerOrNull(form.auto_compact_tokens),
    fast_tier: form.fast_tier,
    usage_hint: form.usage_hint.trim(),
    ...(form.minimum_desktop_version !== undefined
      ? { minimum_desktop_version: form.minimum_desktop_version.trim() }
      : {})
  }
}

/** The form field a server-side CLAUDEX_MODEL_META_INVALID `metadata.field` names, if it is one. */
export function fieldFromServer(field: unknown): ModelMetaField | null {
  const fields: ModelMetaField[] = [
    'model_id',
    'group_id',
    'display_name',
    'description',
    'badges',
    'sort_order',
    'hidden',
    'is_default',
    'supported_efforts',
    'default_effort',
    'context_window',
    'auto_compact_tokens',
    'usage_hint',
    'minimum_desktop_version'
  ]
  if (typeof field !== 'string') return null
  // The server may name an element, e.g. "badges[1]" or "badges.1".
  const base = field.replace(/[[.].*$/, '')
  return (fields as string[]).includes(base) ? (base as ModelMetaField) : null
}
