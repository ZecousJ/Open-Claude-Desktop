// CLAUDEX: tests for the client policy editor logic (validation mirrors design 2.3).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computed, reactive } from 'vue'
import { describe, expect, it } from 'vitest'

import {
  ATTACHMENT_TYPES,
  BUILTIN_POLICY,
  POLICY_ITEMS,
  applyPatch,
  buildUpdateRequest,
  builtinFromResolved,
  cleanPatch,
  countItems,
  domainProblemKey,
  draftFromServer,
  hasItem,
  isValidDomain,
  itemOfField,
  normalizeLoadedPatch,
  removeItem,
  seedValue,
  setItem,
  validatePatch,
  validateUpdateRequest,
  type PolicyIssue
} from '../policyForm'
import type { PolicyPatch } from '@/api/admin/claudex/policy'

function rules(patch: unknown): Array<[string, string]> {
  return validatePatch(patch as PolicyPatch).map((issue: PolicyIssue) => [issue.field, issue.rule])
}

/** Every key and every string value in a JSON value, at any depth. */
function everyKeyAndString(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => everyKeyAndString(entry, out))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      everyKeyAndString(child, out)
    }
  }
  return out
}

describe('validatePatch: permission modes', () => {
  it('accepts the four restrictable modes as a list or per platform', () => {
    expect(rules({ permission_modes: ['auto', 'manual', 'acceptEdits', 'plan'] })).toEqual([])
    expect(
      rules({ permission_modes: { default: ['plan'], darwin: ['auto'], win32: ['manual', 'plan'], linux: ['plan'] } })
    ).toEqual([])
  })

  it('rejects bypass wherever it appears, like the server', () => {
    expect(rules({ permission_modes: ['auto', 'bypass'] })).toEqual([
      ['permission_modes', 'bypass_not_policy_controlled']
    ])
    expect(rules({ permission_modes: { win32: ['bypass'] } })).toEqual([
      ['permission_modes.win32', 'bypass_not_policy_controlled']
    ])
    expect(rules({ scheduled_tasks: { enabled: true, allow_bypass: true } })).toEqual([
      ['scheduled_tasks.allow_bypass', 'bypass_not_policy_controlled']
    ])
    expect(rules({ bypass_permissions: false })).toEqual([['bypass_permissions', 'bypass_not_policy_controlled']])
  })

  it('needs at least one known mode on every platform', () => {
    expect(rules({ permission_modes: [] })).toEqual([['permission_modes', 'empty_mode_list']])
    expect(rules({ permission_modes: ['auto', 'auto'] })).toEqual([])
    expect(rules({ permission_modes: { darwin: ['auto'], linux: [] } })).toEqual([
      ['permission_modes.linux', 'empty_mode_list']
    ])
    expect(rules({ permission_modes: {} })).toEqual([['permission_modes', 'empty_mode_list']])
    expect(rules({ permission_modes: ['yolo'] })).toEqual([['permission_modes', 'unknown_mode']])
    expect(rules({ permission_modes: { android: ['auto'] } })).toEqual([['permission_modes.android', 'unknown_mode']])
  })
})

describe('validatePatch: strict keys', () => {
  it('reports unknown keys at the top level and in merged objects', () => {
    expect(rules({ deep_research: true })).toEqual([['deep_research', 'unknown_field']])
    expect(rules({ links: { help: null, docs: 'https://x.example' } })).toEqual([['links.docs', 'unknown_field']])
    expect(rules({ attachments: { max_bytes: 5 } })).toEqual([['attachments.max_bytes', 'unknown_field']])
  })
})

describe('validatePatch: links', () => {
  it('only accepts https URLs up to 2000 characters, or null', () => {
    expect(rules({ links: { help: 'https://docs.example.com' } })).toEqual([])
    expect(rules({ links: { help: null, plans: null } })).toEqual([])
    expect(rules({ links: { plans: 'http://example.com' } })).toEqual([['links.plans', 'https_required']])
    expect(rules({ links: { apps: 'example.com' } })).toEqual([['links.apps', 'https_required']])
    expect(rules({ links: { get_more_usage: `https://example.com/${'a'.repeat(2000)}` } })).toEqual([
      ['links.get_more_usage', 'too_long']
    ])
  })

  it('checks learn more links: at most 10, label 1-60 characters, https URL required', () => {
    const ok = { label: 'Usage policy', url: 'https://example.com/policy' }
    expect(rules({ links: { learn_more: [ok] } })).toEqual([])
    expect(rules({ links: { learn_more: Array.from({ length: 11 }, () => ok) } })).toEqual([
      ['links.learn_more', 'too_many']
    ])
    expect(rules({ links: { learn_more: [{ label: ' ', url: ok.url }] } })).toEqual([
      ['links.learn_more.0.label', 'required']
    ])
    expect(rules({ links: { learn_more: [{ label: 'x'.repeat(61), url: ok.url }] } })).toEqual([
      ['links.learn_more.0.label', 'too_long']
    ])
    expect(rules({ links: { learn_more: [{ label: 'Docs', url: '' }] } })).toEqual([
      ['links.learn_more.0.url', 'required']
    ])
    expect(rules({ links: { learn_more: [ok, { label: 'Docs', url: 'ftp://x' }] } })).toEqual([
      ['links.learn_more.1.url', 'https_required']
    ])
  })
})

describe('validatePatch: connectors', () => {
  it('accepts null (any), an empty list (none) and names or rules', () => {
    expect(rules({ connectors: null })).toEqual([])
    expect(rules({ connectors: [] })).toEqual([])
    expect(
      rules({ connectors: ['linear', { name: 'github', url_prefix: 'https://api.githubcopilot.com/mcp' }] })
    ).toEqual([])
    expect(
      rules({ connectors: [{ name: 'fs_local-1', command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] }] })
    ).toEqual([])
  })

  it('checks names, URL prefixes, commands and the row limit', () => {
    expect(rules({ connectors: [{ name: '' }] })).toEqual([['connectors.0.name', 'required']])
    expect(rules({ connectors: [{ name: 'has space' }] })).toEqual([['connectors.0.name', 'invalid_name']])
    expect(rules({ connectors: [{ name: 'a'.repeat(101) }] })).toEqual([['connectors.0.name', 'invalid_name']])
    expect(rules({ connectors: [{ name: 'a'.repeat(100) }] })).toEqual([])
    expect(rules({ connectors: [{ name: 'gh', url_prefix: 'http://api.example.com' }] })).toEqual([
      ['connectors.0.url_prefix', 'https_required']
    ])
    expect(rules({ connectors: [{ name: 'gh', command: 'x'.repeat(501) }] })).toEqual([
      ['connectors.0.command', 'too_long']
    ])
    expect(rules({ connectors: Array.from({ length: 201 }, (_, i) => `c${i}`) })).toEqual([['connectors', 'too_many']])
    expect(rules({ connectors: Array.from({ length: 200 }, (_, i) => `c${i}`) })).toEqual([])
  })

  it('checks arguments like the server: they need a command, at most 50, each at most 500 characters', () => {
    expect(rules({ connectors: [{ name: 'fs', args: ['-y'] }] })).toEqual([['connectors.0.command', 'required']])
    expect(rules({ connectors: [{ name: 'fs', command: '  ', args: ['-y'] }] })).toEqual([
      ['connectors.0.command', 'required']
    ])
    expect(rules({ connectors: [{ name: 'fs', command: 'npx', args: Array(51).fill('a') }] })).toEqual([
      ['connectors.0.args', 'too_many']
    ])
    expect(rules({ connectors: [{ name: 'fs', command: 'npx', args: Array(50).fill('a') }] })).toEqual([])
    expect(rules({ connectors: [{ name: 'fs', command: 'npx', args: ['ok', 'x'.repeat(501)] }] })).toEqual([
      ['connectors.0.args.1', 'too_long']
    ])
    // Blank lines of the arguments box are not arguments.
    expect(rules({ connectors: [{ name: 'fs', args: ['', ' '] }] })).toEqual([])
  })

  it('keeps connector arguments through load and submit (strict command + args match)', () => {
    const loaded = normalizeLoadedPatch({
      connectors: [{ name: 'fs', command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] }, 'linear']
    })
    expect(loaded.connectors).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] },
      { name: 'linear' }
    ])
    const sent = cleanPatch({
      connectors: [
        { name: ' fs ', command: ' npx ', args: ['-y', '', '@mcp/server-filesystem', '  ', '/tmp'] },
        { name: 'gh', url_prefix: 'https://x.example', command: '', args: [''] }
      ]
    })
    expect(sent.connectors).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] },
      { name: 'gh', url_prefix: 'https://x.example' }
    ])
  })
})

describe('validatePatch: attachments', () => {
  it('takes a size above 0 and up to 20 MB, or null for the built-in limits', () => {
    expect(rules({ attachments: { max_megabytes: null } })).toEqual([])
    expect(rules({ attachments: { max_megabytes: 20 } })).toEqual([])
    expect(rules({ attachments: { max_megabytes: 0.5 } })).toEqual([])
    expect(rules({ attachments: { max_megabytes: 0 } })).toEqual([['attachments.max_megabytes', 'out_of_range']])
    expect(rules({ attachments: { max_megabytes: 20.5 } })).toEqual([['attachments.max_megabytes', 'out_of_range']])
    expect(rules({ attachments: { max_megabytes: -1 } })).toEqual([['attachments.max_megabytes', 'out_of_range']])
  })

  it('only knows the 30 built-in file types; an empty list turns attachments off', () => {
    expect(ATTACHMENT_TYPES).toHaveLength(30)
    expect(rules({ attachments: { types: [] } })).toEqual([])
    expect(rules({ attachments: { types: [...ATTACHMENT_TYPES] } })).toEqual([])
    expect(rules({ attachments: { types: ['png', 'exe'] } })).toEqual([['attachments.types.1', 'unknown_type']])
  })
})

describe('validatePatch: domains', () => {
  it.each([
    ['docs.example.com', true],
    ['*.example.org', true],
    ['localhost', true],
    ['127.0.0.1', true],
    ['Docs.Example.com', false],
    ['example.com:8080', false],
    ['example.com/path', false],
    ['https://example.com', false],
    ['*example.com', false],
    ['exa mple.com', false],
    ['-bad.example.com', false],
    ['', false]
  ])('%j -> %j', (domain, valid) => {
    expect(isValidDomain(domain)).toBe(valid)
  })

  it('checks both lists; null image domains means any, at most 100 entries', () => {
    expect(rules({ remote_image_domains: null })).toEqual([])
    expect(rules({ remote_image_domains: ['cdn.example.com'], trusted_link_domains: ['*.example.org'] })).toEqual([])
    expect(rules({ trusted_link_domains: ['ok.example.com', 'Bad.example.com'] })).toEqual([
      ['trusted_link_domains.1', 'invalid_domain']
    ])
    const many = Array.from({ length: 101 }, (_, i) => `h${i}.example.com`)
    expect(rules({ remote_image_domains: many })).toEqual([['remote_image_domains', 'too_many']])
  })

  it('lowercases before checking a typed domain (TagInput)', () => {
    expect(domainProblemKey('Docs.Example.com')).toBeNull()
    expect(domainProblemKey('example.com:443')).toBe('admin.claudexPolicy.validation.invalid_domain')
  })
})

describe('validatePatch: numbers and the plan label', () => {
  it('usage reminder is a whole number from 1 to 99', () => {
    expect(rules({ usage_banner: { warn_percent: 1 } })).toEqual([])
    expect(rules({ usage_banner: { warn_percent: 99 } })).toEqual([])
    expect(rules({ usage_banner: { warn_percent: 0 } })).toEqual([['usage_banner.warn_percent', 'out_of_range']])
    expect(rules({ usage_banner: { warn_percent: 100 } })).toEqual([['usage_banner.warn_percent', 'out_of_range']])
    expect(rules({ usage_banner: { warn_percent: 50.5 } })).toEqual([['usage_banner.warn_percent', 'not_integer']])
    expect(rules({ usage_banner: { warn_percent: null } })).toEqual([['usage_banner.warn_percent', 'required']])
  })

  it('max scheduled tasks is empty (no limit) or 0-100', () => {
    expect(rules({ scheduled_tasks: { enabled: false, max_tasks: null } })).toEqual([])
    expect(rules({ scheduled_tasks: { max_tasks: 0 } })).toEqual([])
    expect(rules({ scheduled_tasks: { max_tasks: 100 } })).toEqual([])
    expect(rules({ scheduled_tasks: { max_tasks: 101 } })).toEqual([['scheduled_tasks.max_tasks', 'out_of_range']])
    expect(rules({ scheduled_tasks: { max_tasks: -1 } })).toEqual([['scheduled_tasks.max_tasks', 'out_of_range']])
  })

  it('plan label is 1-20 characters, counted like the server (not UTF-16 units)', () => {
    expect(rules({ plan_label: 'Max' })).toEqual([])
    expect(rules({ plan_label: '  ' })).toEqual([['plan_label', 'required']])
    expect(rules({ plan_label: 'x'.repeat(21) })).toEqual([['plan_label', 'too_long']])
    expect(rules({ plan_label: '😀'.repeat(20) })).toEqual([])
  })
})

describe('items: inherit means the key is missing', () => {
  it('sets, reads and removes items; an emptied parent object disappears', () => {
    const patch: PolicyPatch = {}
    setItem(patch, 'links.help', null)
    expect(hasItem(patch, 'links.help')).toBe(true)
    expect(patch).toEqual({ links: { help: null } })
    setItem(patch, 'links.plans', 'https://x.example')
    removeItem(patch, 'links.help')
    expect(patch).toEqual({ links: { plans: 'https://x.example' } })
    removeItem(patch, 'links.plans')
    expect(patch).toEqual({})
    expect(countItems({ incognito: false, links: { help: null, learn_more: [] }, attachments: { types: [] } })).toBe(4)
  })

  it('lets computeds see items being added and removed on a reactive patch', () => {
    const patch = reactive<PolicyPatch>({})
    const helpSet = computed(() => hasItem(patch, 'links.help'))
    const incognitoSet = computed(() => hasItem(patch, 'incognito'))
    expect([helpSet.value, incognitoSet.value]).toEqual([false, false])
    setItem(patch, 'links.help', null)
    setItem(patch, 'incognito', false)
    expect([helpSet.value, incognitoSet.value]).toEqual([true, true])
    removeItem(patch, 'links.help')
    removeItem(patch, 'incognito')
    expect([helpSet.value, incognitoSet.value]).toEqual([false, false])
  })

  it('maps a server field to the item it belongs to', () => {
    expect(itemOfField('links.learn_more.2.url')).toBe('links.learn_more')
    expect(itemOfField('permission_modes.win32')).toBe('permission_modes')
    expect(itemOfField('connectors.0.name')).toBe('connectors')
    expect(itemOfField('attachments.max_megabytes')).toBe('attachments.max_megabytes')
    expect(itemOfField('nonsense')).toBeUndefined()
  })

  it('seeds an item from what it inherits', () => {
    const inherited = applyPatch(BUILTIN_POLICY, { permission_modes: { default: ['plan'], win32: ['manual'] } })
    expect(seedValue(inherited, 'permission_modes')).toEqual({ darwin: ['plan'], win32: ['manual'], linux: ['plan'] })
    expect(seedValue(BUILTIN_POLICY, 'plan_label')).toBe('')
    expect(seedValue(BUILTIN_POLICY, 'connectors')).toBeNull()
    expect(seedValue(BUILTIN_POLICY, 'attachments.types')).toEqual([...ATTACHMENT_TYPES])
  })
})

describe('applyPatch: merge rules', () => {
  it('replaces scalars and arrays, merges links and attachments per field, replaces learn_more whole', () => {
    const base = applyPatch(BUILTIN_POLICY, {
      incognito: false,
      links: { help: 'https://help.example', learn_more: [{ label: 'A', url: 'https://a.example' }] },
      attachments: { max_megabytes: 10 }
    })
    const merged = applyPatch(base, {
      links: { plans: 'https://plans.example', learn_more: [{ label: 'B', url: 'https://b.example' }] },
      attachments: { types: ['png'] },
      remote_image_domains: ['cdn.example.com']
    })
    expect(merged.incognito).toBe(false)
    expect(merged.links.help).toBe('https://help.example')
    expect(merged.links.plans).toBe('https://plans.example')
    expect(merged.links.learn_more).toEqual([{ label: 'B', url: 'https://b.example' }])
    expect(merged.attachments).toEqual({ max_megabytes: 10, types: ['png'] })
    expect(merged.remote_image_domains).toEqual(['cdn.example.com'])
    // The base is never changed.
    expect(BUILTIN_POLICY.incognito).toBe(true)
  })

  it('reads the built-in defaults the server sends in resolved form', () => {
    const builtin = builtinFromResolved({
      permission_modes: ['auto', 'manual', 'acceptEdits', 'plan', 'bypass' as never],
      attachments: { max_bytes: 10 * 1024 * 1024, types: ['png', 'txt'] },
      usage_banner: { warn_percent: 75 },
      scheduled_tasks: { enabled: false, max_tasks: 5 }
    })
    expect(builtin.permission_modes).toEqual(['auto', 'manual', 'acceptEdits', 'plan'])
    expect(builtin.attachments).toEqual({ max_megabytes: 10, types: ['png', 'txt'] })
    expect(builtin.usage_banner.warn_percent).toBe(75)
    expect(builtin.scheduled_tasks).toEqual({ enabled: false, max_tasks: 5 })
    expect(builtinFromResolved(null)).toEqual(BUILTIN_POLICY)
  })
})

describe('normalizeLoadedPatch and cleanPatch', () => {
  it('drops unknown keys and any bypass mode from loaded data', () => {
    const loaded = normalizeLoadedPatch({
      permission_modes: { default: ['auto', 'bypass'], win32: ['manual', 'bypass'] },
      scheduled_tasks: { enabled: true, allow_bypass: true },
      connectors: ['linear', { name: 'github', url_prefix: 'https://api.githubcopilot.com/mcp', extra: 1 }],
      attachments: { types: ['PNG', 'pdf', 'txt'] },
      research: true
    })
    expect(loaded).toEqual({
      permission_modes: { darwin: ['auto'], win32: ['manual'], linux: ['auto'] },
      scheduled_tasks: { enabled: true },
      connectors: [{ name: 'linear' }, { name: 'github', url_prefix: 'https://api.githubcopilot.com/mcp' }],
      attachments: { types: ['png', 'pdf', 'txt'] }
    })
  })

  it('keeps a present null (explicitly empty) apart from a missing key (inherit)', () => {
    expect(normalizeLoadedPatch({ links: { help: null }, connectors: null })).toEqual({
      links: { help: null },
      connectors: null
    })
    expect(normalizeLoadedPatch({})).toEqual({})
  })

  it('submits only the items that are set, trimmed and in canonical form', () => {
    const cleaned = cleanPatch({
      permission_modes: ['plan', 'auto', 'plan', 'bypass' as never],
      remote_image_domains: [],
      trusted_link_domains: [' Docs.Example.com '],
      connectors: [{ name: ' github ', url_prefix: ' ', command: '' }, 'linear'],
      links: {
        help: '  ',
        plans: ' https://plans.example ',
        learn_more: [{ label: ' Docs ', url: ' https://d.example ' }]
      },
      attachments: { types: ['txt', 'png'] },
      plan_label: ' Max ',
      usage_banner: { warn_percent: 80 }
    } as PolicyPatch)
    expect(cleaned).toEqual({
      permission_modes: ['auto', 'plan'],
      remote_image_domains: null,
      trusted_link_domains: ['docs.example.com'],
      connectors: [{ name: 'github' }, { name: 'linear' }],
      links: { help: null, plans: 'https://plans.example', learn_more: [{ label: 'Docs', url: 'https://d.example' }] },
      attachments: { types: ['png', 'txt'] },
      plan_label: 'Max',
      usage_banner: { warn_percent: 80 }
    })
    expect(cleanPatch({})).toEqual({})
    expect(cleanPatch({ permission_modes: { darwin: ['auto'], win32: ['plan'], linux: ['manual'] } })).toEqual({
      permission_modes: { darwin: ['auto'], win32: ['plan'], linux: ['manual'] }
    })
  })

  it('never puts a bypass key or mode into a PUT body, whatever was loaded', () => {
    const draft = draftFromServer({
      revision: 3,
      defaults: { permission_modes: ['bypass', 'auto'] as never, scheduled_tasks: { allow_bypass: true } as never },
      group_overrides: [
        { group_id: 4, group_name: 'pro', patch: { permission_modes: { win32: ['bypass'] } } as never }
      ],
      user_overrides: [{ user_id: 9, email: 'a', patch: { bypass: true } as never }]
    })
    const body = buildUpdateRequest(draft)
    expect(everyKeyAndString(body).filter((entry) => /bypass/i.test(entry))).toEqual([])
    expect(body.revision).toBe(3)
    // win32 lost its only mode: the admin has to pick one before saving.
    expect(validateUpdateRequest(body).map((issue) => [issue.field, issue.rule])).toEqual([
      ['group_overrides.4.permission_modes.win32', 'empty_mode_list']
    ])
  })
})

describe('validateUpdateRequest', () => {
  it('names fields the way the server does and checks the override counts and size', () => {
    const body = {
      revision: 1,
      defaults: { usage_banner: { warn_percent: 0 } },
      group_overrides: [{ group_id: 4, patch: { plan_label: '' } }],
      user_overrides: [{ user_id: 123, patch: { links: { help: 'http://x' } } }]
    }
    expect(validateUpdateRequest(body).map((issue) => [issue.field, issue.rule])).toEqual([
      ['defaults.usage_banner.warn_percent', 'out_of_range'],
      ['group_overrides.4.plan_label', 'required'],
      ['user_overrides.123.links.help', 'https_required']
    ])
    const tooMany = {
      revision: 1,
      defaults: {},
      group_overrides: Array.from({ length: 201 }, (_, i) => ({ group_id: i + 1, patch: {} })),
      user_overrides: []
    }
    expect(validateUpdateRequest(tooMany).map((issue) => issue.rule)).toEqual(['too_many'])
    const huge = {
      revision: 1,
      defaults: {},
      group_overrides: [],
      user_overrides: Array.from({ length: 900 }, (_, i) => ({
        user_id: i + 1,
        patch: { trusted_link_domains: Array.from({ length: 30 }, (_, j) => `host-${j}.example.com`) }
      }))
    }
    expect(validateUpdateRequest(huge).map((issue) => issue.rule)).toEqual(['too_large'])
  })

  it('covers every editor item', () => {
    expect(POLICY_ITEMS).toHaveLength(47)
  })
})

describe('round 2: memory, research, browser, SSH and computer use', () => {
  it('checks the memory model like the server: exact ID, no spaces or *, null for the default', () => {
    expect(rules({ memory: { model: null } })).toEqual([])
    expect(rules({ memory: { model: 'gpt-5.5-mini' } })).toEqual([])
    expect(rules({ memory: { model: '  ' } })).toEqual([['memory.model', 'required']])
    expect(rules({ memory: { model: 'gpt-*' } })).toEqual([['memory.model', 'invalid_model']])
    expect(rules({ memory: { model: 'gpt 5' } })).toEqual([['memory.model', 'invalid_model']])
    expect(rules({ memory: { model: 'm'.repeat(201) } })).toEqual([['memory.model', 'invalid_model']])
  })

  it('research searches per turn are a whole number from 1 to 200', () => {
    expect(rules({ research: { max_searches_per_turn: 30 } })).toEqual([])
    expect(rules({ research: { max_searches_per_turn: 0 } })).toEqual([
      ['research.max_searches_per_turn', 'out_of_range']
    ])
    expect(rules({ research: { max_searches_per_turn: 201 } })).toEqual([
      ['research.max_searches_per_turn', 'out_of_range']
    ])
    expect(rules({ research: { max_searches_per_turn: null } })).toEqual([
      ['research.max_searches_per_turn', 'required']
    ])
  })

  it('blocked domains are host names, at most 200', () => {
    expect(rules({ browser: { blocked_domains: ['mail.example.com', '*.bank.example'] } })).toEqual([])
    expect(rules({ browser: { blocked_domains: ['https://x.example'] } })).toEqual([
      ['browser.blocked_domains.0', 'invalid_domain']
    ])
    const many = Array.from({ length: 201 }, (_, i) => `d${i}.example.com`)
    expect(rules({ browser: { blocked_domains: many } })).toEqual([['browser.blocked_domains', 'too_many']])
  })

  it('the runtime mirror is an https URL or null', () => {
    expect(rules({ codex_runtime_mirror: null })).toEqual([])
    expect(rules({ codex_runtime_mirror: 'https://registry.npmmirror.com/' })).toEqual([])
    expect(rules({ codex_runtime_mirror: 'http://registry.npmmirror.com/' })).toEqual([
      ['codex_runtime_mirror', 'https_required']
    ])
  })

  it('denied apps are bundle IDs or program names, at most 100; actions per turn 1-1000 or null', () => {
    expect(rules({ computer_use: { denied_apps: ['com.apple.Terminal', 'cmd.exe', 'Google Chrome'] } })).toEqual([])
    expect(rules({ computer_use: { denied_apps: ['rm -rf /;'] } })).toEqual([
      ['computer_use.denied_apps.0', 'invalid_app']
    ])
    expect(rules({ computer_use: { denied_apps: Array.from({ length: 101 }, (_, i) => `app${i}`) } })).toEqual([
      ['computer_use.denied_apps', 'too_many']
    ])
    expect(rules({ computer_use: { max_actions_per_turn: null } })).toEqual([])
    expect(rules({ computer_use: { max_actions_per_turn: 0 } })).toEqual([
      ['computer_use.max_actions_per_turn', 'out_of_range']
    ])
    expect(rules({ computer_use: { max_actions_per_turn: 2.5 } })).toEqual([
      ['computer_use.max_actions_per_turn', 'not_integer']
    ])
  })

  it('rejects unknown keys inside the new blocks, and Bypass everywhere', () => {
    expect(rules({ browser: { import_cookies: true } })).toEqual([['browser.import_cookies', 'unknown_field']])
    expect(rules({ computer_use: { allow_bypass: true } })).toEqual([
      ['computer_use.allow_bypass', 'bypass_not_policy_controlled']
    ])
    expect(rules({ fast: true })).toEqual([['fast', 'unknown_field']])
  })

  it('deny lists start empty in an override: inherited entries stay blocked anyway', () => {
    const inherited = applyPatch(BUILTIN_POLICY, {
      browser: { blocked_domains: ['mail.example.com'] },
      computer_use: { denied_apps: ['cmd.exe'] }
    })
    expect(seedValue(inherited, 'browser.blocked_domains')).toEqual([])
    expect(seedValue(inherited, 'computer_use.denied_apps')).toEqual([])
    expect(seedValue(inherited, 'memory.enabled')).toBe(true)
    expect(seedValue(inherited, 'research.max_searches_per_turn')).toBe(30)
  })

  it('computer use is off in the built-in defaults; the rest is on', () => {
    expect(BUILTIN_POLICY.computer_use.enabled).toBe(false)
    expect(BUILTIN_POLICY.ssh_remote).toBe(true)
    expect(BUILTIN_POLICY.browser.enabled).toBe(true)
    expect(BUILTIN_POLICY.memory.default_on).toBe(false)
  })

  it('reads resolved built-ins, and keeps its own when an older server sends none', () => {
    const out = builtinFromResolved({
      memory: { enabled: false, search_chats: false, generate: false, default_on: false, model: 'm' },
      research: { enabled: true, x_search: false, max_searches_per_turn: 12 },
      computer_use: { enabled: true, allow_full_control: false, denied_apps: ['a'], max_actions_per_turn: 5 },
      ssh_remote: false,
      codex_runtime_mirror: 'https://m.example/'
    })
    expect(out.memory).toEqual({ enabled: false, search_chats: false, generate: false, default_on: false, model: 'm' })
    expect(out.research).toEqual({ enabled: true, x_search: false, max_searches_per_turn: 12 })
    expect(out.computer_use).toEqual({ enabled: true, allow_full_control: false, denied_apps: ['a'], max_actions_per_turn: 5 })
    expect(out.ssh_remote).toBe(false)
    expect(out.codex_runtime_mirror).toBe('https://m.example/')
    expect(out.browser).toEqual(BUILTIN_POLICY.browser)
    expect(builtinFromResolved({})).toEqual(BUILTIN_POLICY)
  })

  it('submits the new items trimmed and canonical; an empty model box means null', () => {
    const patch = normalizeLoadedPatch({
      memory: { model: ' gpt-5.5-mini ', enabled: true, extra: 1 },
      browser: { blocked_domains: [' Mail.Example.COM '] },
      computer_use: { denied_apps: [' cmd.exe ', ''], max_actions_per_turn: 50 },
      codex_runtime_mirror: ' https://registry.npmmirror.com/ ',
      ssh_remote: false
    })
    expect(cleanPatch(patch)).toEqual({
      memory: { model: 'gpt-5.5-mini', enabled: true },
      browser: { blocked_domains: ['mail.example.com'] },
      computer_use: { denied_apps: ['cmd.exe'], max_actions_per_turn: 50 },
      codex_runtime_mirror: 'https://registry.npmmirror.com/',
      ssh_remote: false
    })
    expect(cleanPatch({ memory: { model: '' } })).toEqual({ memory: { model: null } })
    expect(countItems(patch)).toBe(7)
  })
})

describe('server contract fixtures (internal/claudex/contract/testdata)', () => {
  // jsdom replaces the global URL, so resolve the path with node:path.
  const dir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../../backend/internal/claudex/contract/testdata'
  )
  const fixture = (name: string) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'))

  it('saves a loaded policy back as exactly the PUT body the server expects', () => {
    const loaded = fixture('admin-policy.get.json').data
    const draft = draftFromServer(loaded)
    expect(buildUpdateRequest(draft)).toEqual(fixture('admin-policy.put-request.json'))
    expect(validateUpdateRequest(buildUpdateRequest(draft))).toEqual([])
    expect(draft.groups[0].group_name).toBe('claudex-pro')
    expect(builtinFromResolved(loaded.builtin)).toEqual(BUILTIN_POLICY)
  })
})

describe('plan_label null (explicit "no label" the server accepts)', () => {
  it('is kept through load, validation and submit instead of turning into an empty, invalid label', () => {
    const loaded = normalizeLoadedPatch({ plan_label: null })
    expect(loaded).toEqual({ plan_label: null })
    expect(validatePatch(loaded)).toEqual([])
    expect(cleanPatch(loaded)).toEqual({ plan_label: null })
  })
})
