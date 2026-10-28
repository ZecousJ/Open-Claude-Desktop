/**
 * CLAUDEX: client policy editor logic for the console page (/admin/claudex/policy).
 *
 * A patch sets only some fields; everything else inherits (built-in
 * defaults -> defaults -> plan override -> user override). The editor
 * works on "items", the units that inherit on their own: top-level fields,
 * and the sub-fields of links, attachments, usage_banner and
 * scheduled_tasks, which the server merges one by one (links.learn_more is
 * replaced as a whole).
 *
 * validatePatch() mirrors the server's checks (design 2.3,
 * internal/claudex/policy/validate.go); the server stays authoritative.
 *
 * Bypass permissions is never policy-controlled (owner decision 3): no item
 * sets it, loaded data and submitted bodies drop any "bypass" mode, and
 * validatePatch() rejects it like the server does.
 */

import { validateHttpsUrl } from '../common/validation'
import type {
  AdminClientPolicy,
  ConnectorRule,
  PermissionModesValue,
  PolicyLearnMoreLink,
  PolicyMode,
  PolicyPatch,
  PolicyPlatform,
  ResolvedPolicy,
  UpdateClientPolicyRequest
} from '@/api/admin/claudex/policy'

export type EditorMode = 'defaults' | 'plan' | 'user'

export const POLICY_MODES: readonly PolicyMode[] = ['auto', 'manual', 'acceptEdits', 'plan']
export const POLICY_PLATFORMS: readonly PolicyPlatform[] = ['darwin', 'win32', 'linux']

/** File types the desktop app can attach (shared/client-policy.ts attachmentTypes). */
export const ATTACHMENT_TYPES: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'txt',
  'md',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'json',
  'yaml',
  'yml',
  'html',
  'css',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'xml',
  'toml',
  'log'
]

export const POLICY_LIMITS = {
  domains: 100,
  connectors: 200,
  connectorName: 100,
  connectorCommand: 500,
  connectorArgs: 50,
  connectorArg: 500,
  learnMore: 10,
  learnMoreLabel: 60,
  maxMegabytes: 20,
  warnPercentMin: 1,
  warnPercentMax: 99,
  planLabel: 20,
  maxTasks: 100,
  groupOverrides: 200,
  userOverrides: 1000,
  bodyBytes: 256 * 1024,
  modelId: 200,
  maxSearchesMin: 1,
  maxSearchesMax: 200,
  blockedDomains: 200,
  deniedApps: 100,
  appName: 200,
  maxActionsMin: 1,
  maxActionsMax: 1000
} as const

/** Units that inherit on their own, in the order the editor shows them. */
export const POLICY_ITEMS = [
  'permission_modes',
  'incognito',
  'web_search',
  'web_search_default',
  'voice',
  'local_mcp_editing',
  'developer_mode_enabled',
  'remote_images',
  'remote_image_domains',
  'external_links',
  'trusted_link_domains',
  'approvals_always_allow',
  'connectors',
  'attachments.max_megabytes',
  'attachments.types',
  'links.help',
  'links.plans',
  'links.apps',
  'links.get_more_usage',
  'links.usage_learn_more',
  'links.learn_more',
  'usage_banner.warn_percent',
  'scheduled_tasks.enabled',
  'scheduled_tasks.max_tasks',
  'scheduled_tasks.approval_lifetime_days',
  'plan_label',
  'memory.enabled',
  'memory.search_chats',
  'memory.generate',
  'memory.default_on',
  'memory.model',
  'research.enabled',
  'research.x_search',
  'research.max_searches_per_turn',
  'browser.enabled',
  'browser.external_sites',
  'browser.allow_script',
  'browser.dev_servers',
  'browser.blocked_domains',
  'ssh_remote',
  'workflows',
  'workflow_approval_required',
  'codex_runtime_mirror',
  'computer_use.enabled',
  'computer_use.allow_full_control',
  'computer_use.denied_apps',
  'computer_use.max_actions_per_turn'
] as const

/**
 * Deny lists that only grow: a plan or user override adds to what the
 * layers below block and can never allow an entry again (the server merges
 * them as a union), so an override starts from an empty list.
 */
export const UNION_ITEMS: readonly PolicyItem[] = ['browser.blocked_domains', 'computer_use.denied_apps']

export type PolicyItem = (typeof POLICY_ITEMS)[number]

/** A fully resolved policy in patch form (what an item inherits). */
export interface FullPolicy {
  permission_modes: PermissionModesValue
  incognito: boolean
  web_search: boolean
  web_search_default: boolean
  voice: boolean
  local_mcp_editing: boolean
  developer_mode_enabled: boolean
  remote_images: boolean
  remote_image_domains: string[] | null
  external_links: boolean
  trusted_link_domains: string[]
  connectors: ConnectorRule[] | null
  attachments: { max_megabytes: number | null; types: string[] }
  links: {
    help: string | null
    plans: string | null
    apps: string | null
    get_more_usage: string | null
    usage_learn_more: string | null
    learn_more: PolicyLearnMoreLink[]
  }
  usage_banner: { warn_percent: number | null }
  plan_label: string | null
  scheduled_tasks: { enabled: boolean; max_tasks: number | null; approval_lifetime_days?: number | null }
  approvals_always_allow: boolean
  memory: { enabled: boolean; search_chats: boolean; generate: boolean; default_on: boolean; model: string | null }
  research: { enabled: boolean; x_search: boolean; max_searches_per_turn: number | null }
  browser: {
    enabled: boolean
    external_sites: boolean
    allow_script: boolean
    dev_servers: boolean
    blocked_domains: string[]
  }
  ssh_remote: boolean
  workflows: boolean
  workflow_approval_required: boolean
  codex_runtime_mirror: string | null
  computer_use: {
    enabled: boolean
    allow_full_control: boolean
    denied_apps: string[]
    max_actions_per_turn: number | null
  }
}

/** Built-in defaults (design 1.6.1), used when the server does not send them. */
export const BUILTIN_POLICY: FullPolicy = {
  permission_modes: [...POLICY_MODES],
  incognito: true,
  web_search: true,
  web_search_default: false,
  voice: true,
  local_mcp_editing: true,
  developer_mode_enabled: true,
  remote_images: true,
  remote_image_domains: null,
  external_links: true,
  trusted_link_domains: [],
  connectors: null,
  attachments: { max_megabytes: null, types: [...ATTACHMENT_TYPES] },
  links: {
    help: null,
    plans: null,
    apps: null,
    get_more_usage: null,
    usage_learn_more: null,
    learn_more: []
  },
  usage_banner: { warn_percent: 80 },
  plan_label: null,
  scheduled_tasks: { enabled: true, max_tasks: null },
  approvals_always_allow: true,
  memory: { enabled: true, search_chats: true, generate: true, default_on: false, model: null },
  research: { enabled: true, x_search: true, max_searches_per_turn: 30 },
  browser: { enabled: true, external_sites: true, allow_script: true, dev_servers: true, blocked_domains: [] },
  ssh_remote: true,
  workflows: true,
  workflow_approval_required: false,
  codex_runtime_mirror: null,
  // Off until an administrator turns it on.
  computer_use: { enabled: false, allow_full_control: true, denied_apps: [], max_actions_per_turn: null }
}

const MEGABYTE = 1024 * 1024

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function splitItem(item: PolicyItem): [string, string | undefined] {
  const dot = item.indexOf('.')
  return dot < 0 ? [item, undefined] : [item.slice(0, dot), item.slice(dot + 1)]
}

/**
 * An own key with a defined value. The `in` check comes first because Vue
 * tracks it (a reactive patch then updates computeds when the key is added
 * or removed); Object.prototype.hasOwnProperty.call alone is not tracked.
 */
function hasOwnValue(obj: Obj, key: string): boolean {
  return key in obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined
}

/** Whether a patch sets an item (a present key, even null, counts). */
export function hasItem(patch: unknown, item: PolicyItem): boolean {
  if (!isObject(patch)) return false
  const [head, tail] = splitItem(item)
  if (!hasOwnValue(patch, head)) return false
  if (tail === undefined) return true
  const parent = patch[head]
  return isObject(parent) && hasOwnValue(parent, tail)
}

export function getItem(source: unknown, item: PolicyItem): unknown {
  if (!isObject(source)) return undefined
  const [head, tail] = splitItem(item)
  const value = source[head]
  if (tail === undefined) return value
  return isObject(value) ? value[tail] : undefined
}

/** Sets an item in place, creating its parent object when needed. */
export function setItem(target: object, item: PolicyItem, value: unknown): void {
  const obj = target as Obj
  const [head, tail] = splitItem(item)
  if (tail === undefined) {
    obj[head] = value
    return
  }
  if (!isObject(obj[head])) obj[head] = {}
  ;(obj[head] as Obj)[tail] = value
}

/** Removes an item in place (the item inherits again); drops an emptied parent. */
export function removeItem(target: object, item: PolicyItem): void {
  const obj = target as Obj
  const [head, tail] = splitItem(item)
  if (tail === undefined) {
    delete obj[head]
    return
  }
  const parent = obj[head]
  if (!isObject(parent)) return
  delete parent[tail]
  if (Object.keys(parent).length === 0) delete obj[head]
}

/** How many items a patch sets (the "overrides" column). */
export function countItems(patch: PolicyPatch): number {
  return POLICY_ITEMS.filter((item) => hasItem(patch, item)).length
}

/** The known modes of a list in the fixed order, without duplicates or Bypass. */
export function cleanModes(value: unknown): PolicyMode[] {
  const list = Array.isArray(value) ? value : []
  return POLICY_MODES.filter((mode) => list.includes(mode))
}

/**
 * Editor form of permission modes: a list, or one list per platform. A
 * stored `default` list fills platforms it does not name.
 */
export function normalizeModes(value: unknown): PermissionModesValue {
  if (Array.isArray(value)) return cleanModes(value)
  if (isObject(value)) {
    const fallback = Array.isArray(value.default) ? value.default : [...POLICY_MODES]
    const out: Partial<Record<PolicyPlatform, PolicyMode[]>> = {}
    for (const platform of POLICY_PLATFORMS) {
      out[platform] = cleanModes(Array.isArray(value[platform]) ? value[platform] : fallback)
    }
    return out
  }
  return [...POLICY_MODES]
}

/** The modes one platform gets from a stored value. */
export function modesFor(value: PermissionModesValue, platform: PolicyPlatform): PolicyMode[] {
  if (Array.isArray(value)) return cleanModes(value)
  const list = value[platform] ?? value.default
  return list ? cleanModes(list) : [...POLICY_MODES]
}

function toConnectorRule(value: unknown): ConnectorRule {
  if (typeof value === 'string') return { name: value }
  const src = isObject(value) ? value : {}
  const rule: ConnectorRule = { name: typeof src.name === 'string' ? src.name : '' }
  if (typeof src.url_prefix === 'string' && src.url_prefix) rule.url_prefix = src.url_prefix
  if (typeof src.command === 'string' && src.command) rule.command = src.command
  if (Array.isArray(src.args)) rule.args = stringList(src.args)
  return rule
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function learnMoreList(value: unknown): PolicyLearnMoreLink[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const src = isObject(entry) ? entry : {}
    return {
      label: typeof src.label === 'string' ? src.label : '',
      url: typeof src.url === 'string' ? src.url : ''
    }
  })
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Normalizes one loaded item to the form the editor works with. */
function normalizeItem(item: PolicyItem, value: unknown): unknown {
  switch (item) {
    case 'permission_modes':
      return normalizeModes(value)
    case 'remote_image_domains':
      return value === null ? null : stringList(value)
    case 'trusted_link_domains':
      return stringList(value)
    case 'connectors':
      return value === null ? null : Array.isArray(value) ? value.map(toConnectorRule) : null
    case 'attachments.max_megabytes':
    case 'scheduled_tasks.max_tasks':
    case 'scheduled_tasks.approval_lifetime_days':
    case 'usage_banner.warn_percent':
    case 'research.max_searches_per_turn':
    case 'computer_use.max_actions_per_turn':
      return numberOrNull(value)
    case 'attachments.types': {
      const list = stringList(value).map((v) => v.toLowerCase())
      return ATTACHMENT_TYPES.filter((type) => list.includes(type))
    }
    case 'browser.blocked_domains':
    case 'computer_use.denied_apps':
      return stringList(value)
    case 'memory.model':
    case 'codex_runtime_mirror':
      return stringOrNull(value)
    case 'links.help':
    case 'links.plans':
    case 'links.apps':
    case 'links.get_more_usage':
    case 'links.usage_learn_more':
      return stringOrNull(value)
    case 'links.learn_more':
      return learnMoreList(value)
    case 'plan_label':
      // null is the server's explicit "no label" (it hides an inherited one).
      return value === null ? null : typeof value === 'string' ? value : ''
    default:
      return Boolean(value)
  }
}

/**
 * A patch as loaded from the server, reduced to the known items in editor
 * form. Unknown keys and any "bypass" mode are dropped.
 */
export function normalizeLoadedPatch(raw: unknown): PolicyPatch {
  const out: PolicyPatch = {}
  for (const item of POLICY_ITEMS) {
    if (hasItem(raw, item)) setItem(out, item, normalizeItem(item, clone(getItem(raw, item))))
  }
  return out
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

function cleanDomains(value: unknown): string[] {
  return stringList(value)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

/** One item as it is sent to the server. */
function cleanItem(item: PolicyItem, value: unknown): unknown {
  switch (item) {
    case 'permission_modes': {
      if (Array.isArray(value)) return cleanModes(value)
      const src = isObject(value) ? value : {}
      const out: Partial<Record<PolicyPlatform, PolicyMode[]>> = {}
      for (const platform of POLICY_PLATFORMS) out[platform] = cleanModes(src[platform])
      return out
    }
    case 'remote_image_domains': {
      const list = value === null ? [] : cleanDomains(value)
      return list.length ? list : null
    }
    case 'trusted_link_domains':
      return cleanDomains(value)
    case 'connectors':
      if (value === null || !Array.isArray(value)) return null
      return value.map((entry) => {
        const src = toConnectorRule(entry)
        const rule: ConnectorRule = { name: src.name.trim() }
        const prefix = trimOrNull(src.url_prefix)
        const command = trimOrNull(src.command)
        if (prefix) rule.url_prefix = prefix
        if (command) rule.command = command
        // Blank lines of the arguments box are not arguments.
        const args = (src.args ?? []).filter((arg) => arg.trim() !== '')
        if (args.length) rule.args = args
        return rule
      })
    case 'attachments.max_megabytes':
    case 'scheduled_tasks.max_tasks':
    case 'scheduled_tasks.approval_lifetime_days':
    case 'usage_banner.warn_percent':
    case 'research.max_searches_per_turn':
    case 'computer_use.max_actions_per_turn':
      return numberOrNull(value)
    case 'browser.blocked_domains':
      return cleanDomains(value)
    case 'computer_use.denied_apps':
      return stringList(value)
        .map((v) => v.trim())
        .filter(Boolean)
    case 'memory.model':
    case 'codex_runtime_mirror':
      return trimOrNull(value)
    case 'attachments.types': {
      const list = stringList(value)
      return [
        ...ATTACHMENT_TYPES.filter((type) => list.includes(type)),
        ...list.filter((type, i) => !ATTACHMENT_TYPES.includes(type) && list.indexOf(type) === i)
      ]
    }
    case 'links.help':
    case 'links.plans':
    case 'links.apps':
    case 'links.get_more_usage':
    case 'links.usage_learn_more':
      return trimOrNull(value)
    case 'links.learn_more':
      return learnMoreList(value).map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
    case 'plan_label':
      return value === null ? null : typeof value === 'string' ? value.trim() : ''
    default:
      return Boolean(value)
  }
}

/**
 * The patch as it is submitted: only the items it sets, trimmed, empty links
 * as null, an empty image-domain list as null (any domain). It never carries
 * a Bypass mode or any key outside the known items.
 */
export function cleanPatch(patch: PolicyPatch): PolicyPatch {
  const out: PolicyPatch = {}
  for (const item of POLICY_ITEMS) {
    if (hasItem(patch, item)) setItem(out, item, cleanItem(item, getItem(patch, item)))
  }
  return out
}

/** Built-in defaults in editor form, from the server's resolved `builtin`. */
export function builtinFromResolved(resolved: Partial<ResolvedPolicy> | null | undefined): FullPolicy {
  const out = clone(BUILTIN_POLICY)
  if (!isObject(resolved)) return out
  const src = resolved as Obj
  if (Array.isArray(src.permission_modes)) out.permission_modes = cleanModes(src.permission_modes)
  for (const key of [
    'incognito',
    'web_search',
    'web_search_default',
    'voice',
    'local_mcp_editing',
    'developer_mode_enabled',
    'remote_images',
    'external_links',
    'approvals_always_allow'
  ] as const) {
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean
  }
  if (src.remote_image_domains === null || Array.isArray(src.remote_image_domains)) {
    out.remote_image_domains = src.remote_image_domains === null ? null : stringList(src.remote_image_domains)
  }
  if (Array.isArray(src.trusted_link_domains)) out.trusted_link_domains = stringList(src.trusted_link_domains)
  if (src.connectors === null || Array.isArray(src.connectors)) {
    out.connectors = src.connectors === null ? null : (src.connectors as unknown[]).map(toConnectorRule)
  }
  if (isObject(src.attachments)) {
    const bytes = numberOrNull(src.attachments.max_bytes)
    out.attachments.max_megabytes = bytes === null ? null : Math.round((bytes / MEGABYTE) * 1000) / 1000
    if (Array.isArray(src.attachments.types)) {
      out.attachments.types = normalizeItem('attachments.types', src.attachments.types) as string[]
    }
  }
  if (isObject(src.links)) {
    for (const key of ['help', 'plans', 'apps', 'get_more_usage', 'usage_learn_more'] as const) {
      if (key in src.links) out.links[key] = stringOrNull(src.links[key])
    }
    if (Array.isArray(src.links.learn_more)) out.links.learn_more = learnMoreList(src.links.learn_more)
  }
  if (isObject(src.usage_banner) && typeof src.usage_banner.warn_percent === 'number') {
    out.usage_banner.warn_percent = src.usage_banner.warn_percent
  }
  if (typeof src.plan_label === 'string') out.plan_label = src.plan_label
  if (isObject(src.scheduled_tasks)) {
    if (typeof src.scheduled_tasks.enabled === 'boolean') out.scheduled_tasks.enabled = src.scheduled_tasks.enabled
    if ('max_tasks' in src.scheduled_tasks) out.scheduled_tasks.max_tasks = numberOrNull(src.scheduled_tasks.max_tasks)
    if ('approval_lifetime_days' in src.scheduled_tasks) out.scheduled_tasks.approval_lifetime_days = numberOrNull(src.scheduled_tasks.approval_lifetime_days)
  }
  // Round-2 blocks (absent from an older server: the built-in values stay).
  const blocks = {
    memory: ['enabled', 'search_chats', 'generate', 'default_on'],
    research: ['enabled', 'x_search'],
    browser: ['enabled', 'external_sites', 'allow_script', 'dev_servers'],
    computer_use: ['enabled', 'allow_full_control']
  } as const
  for (const [block, keys] of Object.entries(blocks) as Array<[keyof typeof blocks, readonly string[]]>) {
    const from = src[block]
    if (!isObject(from)) continue
    const to = out[block] as unknown as Obj
    for (const key of keys) if (typeof from[key] === 'boolean') to[key] = from[key]
  }
  if (isObject(src.memory) && 'model' in src.memory) out.memory.model = stringOrNull(src.memory.model)
  if (isObject(src.research) && typeof src.research.max_searches_per_turn === 'number') {
    out.research.max_searches_per_turn = src.research.max_searches_per_turn
  }
  if (isObject(src.browser) && Array.isArray(src.browser.blocked_domains)) {
    out.browser.blocked_domains = stringList(src.browser.blocked_domains)
  }
  if (typeof src.ssh_remote === 'boolean') out.ssh_remote = src.ssh_remote
  if (typeof src.workflows === 'boolean') out.workflows = src.workflows
  if (typeof src.workflow_approval_required === 'boolean')
    out.workflow_approval_required = src.workflow_approval_required
  if ('codex_runtime_mirror' in src) out.codex_runtime_mirror = stringOrNull(src.codex_runtime_mirror)
  if (isObject(src.computer_use)) {
    if (Array.isArray(src.computer_use.denied_apps)) out.computer_use.denied_apps = stringList(src.computer_use.denied_apps)
    if ('max_actions_per_turn' in src.computer_use) {
      out.computer_use.max_actions_per_turn = numberOrNull(src.computer_use.max_actions_per_turn)
    }
  }
  return out
}

/**
 * `base` with every item the patch sets laid over it. The result shares
 * the patch's arrays and objects (the editor edits through it); `base` is
 * copied and never changed. A deny list (UNION_ITEMS) shows the patch's own
 * additions; the editor lists the inherited entries next to it.
 */
export function applyPatch(base: FullPolicy, patch: PolicyPatch): FullPolicy {
  const out = clone(base)
  for (const item of POLICY_ITEMS) {
    if (hasItem(patch, item)) setItem(out, item, getItem(patch, item))
  }
  return out
}

/** A copy of what an item inherits, as the starting value when it stops inheriting. */
export function seedValue(inherited: FullPolicy, item: PolicyItem): unknown {
  // A deny list adds to the inherited one, so it starts empty.
  if (UNION_ITEMS.includes(item)) return []
  const value = clone(getItem(inherited, item))
  if (item === 'permission_modes') return normalizeModes(value)
  if (item === 'plan_label') return typeof value === 'string' ? value : ''
  if (item === 'remote_image_domains') return value === null ? null : stringList(value)
  return value === undefined ? null : value
}

// ---------------------------------------------------------------- validation

export type PolicyRule =
  | 'bypass_not_policy_controlled'
  | 'unknown_mode'
  | 'empty_mode_list'
  | 'https_required'
  | 'too_long'
  | 'too_many'
  | 'required'
  | 'out_of_range'
  | 'not_integer'
  | 'invalid_name'
  | 'invalid_domain'
  | 'unknown_type'
  | 'too_large'
  | 'unknown_field'
  | 'invalid_model'
  | 'invalid_app'

export interface PolicyIssue {
  /** Path inside the patch, e.g. "permission_modes.win32", "links.learn_more.2.url". */
  field: string
  rule: PolicyRule
  params?: Record<string, number>
}

const CONNECTOR_NAME = /^[a-zA-Z0-9_-]{1,100}$/
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DOMAIN = new RegExp(`^(?:\\*\\.)?${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`)

/** Characters as the server counts them (runes, not UTF-16 units). */
function runeLength(text: string): number {
  return [...text].length
}

/** Whether a domain entry is a lowercase host name or a "*." wildcard, with no port or path. */
export function isValidDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN.test(value)
}

/** TagInput check for domain lists: an i18n key for a rejected value. */
export function domainProblemKey(value: string): string | null {
  return isValidDomain(value.trim().toLowerCase()) ? null : 'admin.claudexPolicy.validation.invalid_domain'
}

function checkModes(list: unknown, field: string, issues: PolicyIssue[]): void {
  const values = Array.isArray(list) ? list : []
  let unknown = false
  for (const mode of values) {
    if (mode === 'bypass') {
      issues.push({ field, rule: 'bypass_not_policy_controlled' })
      unknown = true
    } else if (!POLICY_MODES.includes(mode as PolicyMode)) {
      issues.push({ field, rule: 'unknown_mode' })
      unknown = true
    }
  }
  if (!unknown && cleanModes(values).length === 0) issues.push({ field, rule: 'empty_mode_list' })
}

function checkUrl(value: unknown, field: string, issues: PolicyIssue[], required = false): void {
  const problem = validateHttpsUrl(typeof value === 'string' ? value : null, { required })
  if (problem === 'required') issues.push({ field, rule: 'required' })
  else if (problem === 'tooLong') issues.push({ field, rule: 'too_long', params: { max: 2000 } })
  else if (problem) issues.push({ field, rule: 'https_required' })
}

const APP_NAME = /^[A-Za-z0-9._ -]+$/

/** Whether a denied-app entry is a bundle id or program name the server accepts. */
export function isValidAppName(value: string): boolean {
  const name = value.trim()
  return name !== '' && runeLength(name) <= POLICY_LIMITS.appName && APP_NAME.test(name)
}

/** TagInput check for the denied apps: an i18n key for a rejected value. */
export function appProblemKey(value: string): string | null {
  return isValidAppName(value) ? null : 'admin.claudexPolicy.validation.invalid_app'
}

/** Whether a model id is exact (no spaces or *, at most 200 characters), like the catalog's. */
export function isValidModelId(value: string): boolean {
  return runeLength(value) <= POLICY_LIMITS.modelId && /^[^\s*]+$/u.test(value)
}

function checkDomains(value: unknown, field: string, issues: PolicyIssue[], limit: number = POLICY_LIMITS.domains): void {
  if (value === null) return
  const list = Array.isArray(value) ? value : []
  if (list.length > limit) {
    issues.push({ field, rule: 'too_many', params: { max: limit } })
  }
  list.forEach((entry, i) => {
    if (typeof entry !== 'string' || !isValidDomain(entry))
      issues.push({ field: `${field}.${i}`, rule: 'invalid_domain' })
  })
}

function checkInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  nullable: boolean,
  issues: PolicyIssue[]
): void {
  if (value === null || value === undefined) {
    if (!nullable) issues.push({ field, rule: 'required' })
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ field, rule: 'not_integer' })
  } else if (!Number.isInteger(value)) {
    issues.push({ field, rule: 'not_integer' })
  } else if (value < min || value > max) {
    issues.push({ field, rule: 'out_of_range', params: { min, max } })
  }
}

/** Known sub-fields of the objects the server merges field by field. */
const NESTED_KEYS: Record<string, readonly string[]> = (() => {
  const out: Record<string, string[]> = {}
  for (const item of POLICY_ITEMS) {
    const [head, tail] = splitItem(item)
    if (tail !== undefined) (out[head] ??= []).push(tail)
  }
  return out
})()
const TOP_KEYS = new Set(POLICY_ITEMS.map((item) => splitItem(item)[0]))

/**
 * The server parses patches strictly: an unknown key is an error, and a key
 * about Bypass (such as the removed scheduled_tasks.allow_bypass) is
 * rejected as not policy-controlled.
 */
function checkUnknownKeys(patch: Obj, issues: PolicyIssue[]): void {
  const report = (field: string, key: string) =>
    issues.push({ field, rule: /bypass/i.test(key) ? 'bypass_not_policy_controlled' : 'unknown_field' })
  for (const [key, value] of Object.entries(patch)) {
    if (!TOP_KEYS.has(key)) {
      report(key, key)
      continue
    }
    const tails = NESTED_KEYS[key]
    if (tails && isObject(value)) {
      for (const sub of Object.keys(value)) if (!tails.includes(sub)) report(`${key}.${sub}`, sub)
    }
  }
}

/**
 * The problems the server would report for a patch (design 2.3). Field
 * paths are relative to the patch.
 */
export function validatePatch(patch: PolicyPatch): PolicyIssue[] {
  const issues: PolicyIssue[] = []
  const p = patch as Obj
  checkUnknownKeys(p, issues)

  if (hasItem(p, 'permission_modes')) {
    const value = p.permission_modes
    if (Array.isArray(value)) {
      checkModes(value, 'permission_modes', issues)
    } else if (isObject(value)) {
      for (const [key, list] of Object.entries(value)) {
        if (key === 'default' || (POLICY_PLATFORMS as readonly string[]).includes(key)) {
          checkModes(list, `permission_modes.${key}`, issues)
        } else {
          issues.push({ field: `permission_modes.${key}`, rule: 'unknown_mode' })
        }
      }
      if (Object.keys(value).length === 0) issues.push({ field: 'permission_modes', rule: 'empty_mode_list' })
    } else {
      issues.push({ field: 'permission_modes', rule: 'empty_mode_list' })
    }
  }

  if (hasItem(p, 'remote_image_domains')) checkDomains(p.remote_image_domains, 'remote_image_domains', issues)
  if (hasItem(p, 'trusted_link_domains')) checkDomains(p.trusted_link_domains, 'trusted_link_domains', issues)

  if (hasItem(p, 'connectors') && p.connectors !== null) {
    const list = Array.isArray(p.connectors) ? p.connectors : []
    if (list.length > POLICY_LIMITS.connectors) {
      issues.push({ field: 'connectors', rule: 'too_many', params: { max: POLICY_LIMITS.connectors } })
    }
    list.forEach((entry, i) => {
      const rule = toConnectorRule(entry)
      if (!rule.name) issues.push({ field: `connectors.${i}.name`, rule: 'required' })
      else if (!CONNECTOR_NAME.test(rule.name)) issues.push({ field: `connectors.${i}.name`, rule: 'invalid_name' })
      if (rule.url_prefix) checkUrl(rule.url_prefix, `connectors.${i}.url_prefix`, issues)
      if (rule.command && runeLength(rule.command) > POLICY_LIMITS.connectorCommand) {
        issues.push({
          field: `connectors.${i}.command`,
          rule: 'too_long',
          params: { max: POLICY_LIMITS.connectorCommand }
        })
      }
      // Arguments only bind a local command (strict match: program and arguments).
      const args = (rule.args ?? []).filter((arg) => arg.trim() !== '')
      if (args.length && !rule.command?.trim()) issues.push({ field: `connectors.${i}.command`, rule: 'required' })
      if (args.length > POLICY_LIMITS.connectorArgs) {
        issues.push({ field: `connectors.${i}.args`, rule: 'too_many', params: { max: POLICY_LIMITS.connectorArgs } })
      }
      args.forEach((arg, j) => {
        if (runeLength(arg) > POLICY_LIMITS.connectorArg) {
          issues.push({
            field: `connectors.${i}.args.${j}`,
            rule: 'too_long',
            params: { max: POLICY_LIMITS.connectorArg }
          })
        }
      })
    })
  }

  if (hasItem(p, 'attachments.max_megabytes')) {
    const value = getItem(p, 'attachments.max_megabytes')
    if (value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > POLICY_LIMITS.maxMegabytes) {
        issues.push({
          field: 'attachments.max_megabytes',
          rule: 'out_of_range',
          params: { min: 0, max: POLICY_LIMITS.maxMegabytes }
        })
      }
    }
  }
  if (hasItem(p, 'attachments.types')) {
    const list = getItem(p, 'attachments.types')
    ;(Array.isArray(list) ? list : []).forEach((type, i) => {
      if (!ATTACHMENT_TYPES.includes(type as string))
        issues.push({ field: `attachments.types.${i}`, rule: 'unknown_type' })
    })
  }

  for (const key of ['help', 'plans', 'apps', 'get_more_usage', 'usage_learn_more'] as const) {
    const item = `links.${key}` as PolicyItem
    if (hasItem(p, item)) {
      const value = getItem(p, item)
      if (value !== null) checkUrl(value, item, issues)
    }
  }
  if (hasItem(p, 'links.learn_more')) {
    const list = getItem(p, 'links.learn_more')
    const links = Array.isArray(list) ? list : []
    if (links.length > POLICY_LIMITS.learnMore) {
      issues.push({ field: 'links.learn_more', rule: 'too_many', params: { max: POLICY_LIMITS.learnMore } })
    }
    links.forEach((entry, i) => {
      const link = isObject(entry) ? entry : {}
      const label = typeof link.label === 'string' ? link.label : ''
      if (!label.trim()) issues.push({ field: `links.learn_more.${i}.label`, rule: 'required' })
      else if (runeLength(label) > POLICY_LIMITS.learnMoreLabel) {
        issues.push({
          field: `links.learn_more.${i}.label`,
          rule: 'too_long',
          params: { max: POLICY_LIMITS.learnMoreLabel }
        })
      }
      checkUrl(link.url, `links.learn_more.${i}.url`, issues, true)
    })
  }

  if (hasItem(p, 'usage_banner.warn_percent')) {
    checkInteger(
      getItem(p, 'usage_banner.warn_percent'),
      'usage_banner.warn_percent',
      POLICY_LIMITS.warnPercentMin,
      POLICY_LIMITS.warnPercentMax,
      false,
      issues
    )
  }
  if (hasItem(p, 'scheduled_tasks.max_tasks')) {
    checkInteger(
      getItem(p, 'scheduled_tasks.max_tasks'),
      'scheduled_tasks.max_tasks',
      0,
      POLICY_LIMITS.maxTasks,
      true,
      issues
    )
  }
  if (hasItem(p, 'scheduled_tasks.approval_lifetime_days')) {
    checkInteger(getItem(p, 'scheduled_tasks.approval_lifetime_days'), 'scheduled_tasks.approval_lifetime_days', 0, 36500, true, issues)
  }
  if (hasItem(p, 'plan_label') && p.plan_label !== null) {
    const label = typeof p.plan_label === 'string' ? p.plan_label : ''
    if (!label.trim()) issues.push({ field: 'plan_label', rule: 'required' })
    else if (runeLength(label) > POLICY_LIMITS.planLabel) {
      issues.push({ field: 'plan_label', rule: 'too_long', params: { max: POLICY_LIMITS.planLabel } })
    }
  }

  if (hasItem(p, 'memory.model')) {
    const value = getItem(p, 'memory.model')
    if (value !== null) {
      const model = typeof value === 'string' ? value.trim() : ''
      if (!model) issues.push({ field: 'memory.model', rule: 'required' })
      else if (!isValidModelId(model)) issues.push({ field: 'memory.model', rule: 'invalid_model' })
    }
  }
  if (hasItem(p, 'research.max_searches_per_turn')) {
    checkInteger(
      getItem(p, 'research.max_searches_per_turn'),
      'research.max_searches_per_turn',
      POLICY_LIMITS.maxSearchesMin,
      POLICY_LIMITS.maxSearchesMax,
      false,
      issues
    )
  }
  if (hasItem(p, 'browser.blocked_domains')) {
    checkDomains(getItem(p, 'browser.blocked_domains'), 'browser.blocked_domains', issues, POLICY_LIMITS.blockedDomains)
  }
  if (hasItem(p, 'codex_runtime_mirror')) {
    const value = getItem(p, 'codex_runtime_mirror')
    if (value !== null) checkUrl(value, 'codex_runtime_mirror', issues)
  }
  if (hasItem(p, 'computer_use.denied_apps')) {
    const list = getItem(p, 'computer_use.denied_apps')
    const apps = Array.isArray(list) ? list : []
    if (apps.length > POLICY_LIMITS.deniedApps) {
      issues.push({ field: 'computer_use.denied_apps', rule: 'too_many', params: { max: POLICY_LIMITS.deniedApps } })
    }
    apps.forEach((entry, i) => {
      if (typeof entry !== 'string' || !isValidAppName(entry))
        issues.push({ field: `computer_use.denied_apps.${i}`, rule: 'invalid_app' })
    })
  }
  if (hasItem(p, 'computer_use.max_actions_per_turn')) {
    checkInteger(
      getItem(p, 'computer_use.max_actions_per_turn'),
      'computer_use.max_actions_per_turn',
      POLICY_LIMITS.maxActionsMin,
      POLICY_LIMITS.maxActionsMax,
      true,
      issues
    )
  }

  return issues
}

/** The item an issue belongs to (for showing it next to the control). */
export function itemOfField(field: string): PolicyItem | undefined {
  return [...POLICY_ITEMS]
    .sort((a, b) => b.length - a.length)
    .find((item) => field === item || field.startsWith(`${item}.`))
}

// ------------------------------------------------------------ whole policy

/** A user chosen in the user search. */
export interface PickedUser {
  id: number
  email: string
  username?: string
}

/** Who an override is for (a group or a user). */
export interface OverrideTarget {
  id: number
  name: string
}

/** An option of the group select. */
export interface GroupOption {
  value: number
  label: string
  [key: string]: unknown
}

export interface GroupOverrideDraft {
  group_id: number
  group_name: string
  patch: PolicyPatch
}

export interface UserOverrideDraft {
  user_id: number
  email: string
  patch: PolicyPatch
}

export interface PolicyDraft {
  revision: number
  defaults: PolicyPatch
  groups: GroupOverrideDraft[]
  users: UserOverrideDraft[]
}

/** The editor state for a policy loaded from GET /admin/claudex/policy. */
export function draftFromServer(policy: AdminClientPolicy): PolicyDraft {
  return {
    revision: typeof policy.revision === 'number' ? policy.revision : 0,
    defaults: normalizeLoadedPatch(policy.defaults),
    groups: (policy.group_overrides ?? []).map((entry) => ({
      group_id: entry.group_id,
      group_name: entry.group_name ?? '',
      patch: normalizeLoadedPatch(entry.patch)
    })),
    users: (policy.user_overrides ?? []).map((entry) => ({
      user_id: entry.user_id,
      email: entry.email ?? '',
      patch: normalizeLoadedPatch(entry.patch)
    }))
  }
}

/** The PUT body for a draft (cleaned patches; the revision the edit started from). */
export function buildUpdateRequest(draft: PolicyDraft): UpdateClientPolicyRequest {
  return {
    revision: draft.revision,
    defaults: cleanPatch(draft.defaults),
    group_overrides: draft.groups.map((entry) => ({ group_id: entry.group_id, patch: cleanPatch(entry.patch) })),
    user_overrides: draft.users.map((entry) => ({ user_id: entry.user_id, patch: cleanPatch(entry.patch) }))
  }
}

/** Problems of a whole PUT body, with fields as the server names them. */
export function validateUpdateRequest(body: UpdateClientPolicyRequest): PolicyIssue[] {
  const issues: PolicyIssue[] = []
  for (const issue of validatePatch(body.defaults)) issues.push({ ...issue, field: `defaults.${issue.field}` })
  if (body.group_overrides.length > POLICY_LIMITS.groupOverrides) {
    issues.push({ field: 'group_overrides', rule: 'too_many', params: { max: POLICY_LIMITS.groupOverrides } })
  }
  for (const entry of body.group_overrides) {
    for (const issue of validatePatch(entry.patch)) {
      issues.push({ ...issue, field: `group_overrides.${entry.group_id}.${issue.field}` })
    }
  }
  if (body.user_overrides.length > POLICY_LIMITS.userOverrides) {
    issues.push({ field: 'user_overrides', rule: 'too_many', params: { max: POLICY_LIMITS.userOverrides } })
  }
  for (const entry of body.user_overrides) {
    for (const issue of validatePatch(entry.patch)) {
      issues.push({ ...issue, field: `user_overrides.${entry.user_id}.${issue.field}` })
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length
  if (bytes > POLICY_LIMITS.bodyBytes) issues.push({ field: '', rule: 'too_large', params: { max: 256 } })
  return issues
}
