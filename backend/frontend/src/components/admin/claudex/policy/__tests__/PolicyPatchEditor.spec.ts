// CLAUDEX: tests for the client policy patch editor (inherit semantics,
// per-platform permission modes, validation messages, no Bypass control).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import PolicyPatchEditor from '../PolicyPatchEditor.vue'
import { BUILTIN_POLICY, applyPatch, type EditorMode, type FullPolicy } from '../policyForm'
import type { PolicyPatch } from '@/api/admin/claudex/policy'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length ? `${key}${JSON.stringify(params)}` : key,
    te: () => false
  })
}))

function mountEditor(
  options: { patch?: PolicyPatch; mode?: EditorMode; inherited?: FullPolicy; fallbacks?: Record<string, string> } = {}
) {
  const wrapper: VueWrapper = mount(PolicyPatchEditor, {
    props: {
      modelValue: options.patch ?? {},
      mode: options.mode ?? 'plan',
      inherited: options.inherited ?? applyPatch(BUILTIN_POLICY, {}),
      fallbacks: options.fallbacks ?? null,
      'onUpdate:modelValue': (value: PolicyPatch) => wrapper.setProps({ modelValue: value })
    }
  })
  return wrapper
}

function lastPatch(wrapper: VueWrapper): PolicyPatch {
  const events = wrapper.emitted('update:modelValue') ?? []
  return (events.at(-1)?.[0] ?? {}) as PolicyPatch
}

function item(wrapper: VueWrapper, key: string) {
  return wrapper.get(`[data-testid="policy-item-${key}"]`)
}

async function uninherit(wrapper: VueWrapper, key: string) {
  await item(wrapper, key).get('[data-testid="policy-inherit"]').setValue(false)
  await flushPromises()
}

describe('PolicyPatchEditor', () => {
  it('has no Bypass permissions control and always shows the fixed note', () => {
    const wrapper = mountEditor({ mode: 'defaults' })
    const modes = wrapper.findAll('[data-testid^="policy-mode-"]').map((node) => node.attributes('data-testid'))
    expect(modes).toEqual(['policy-mode-auto', 'policy-mode-manual', 'policy-mode-acceptEdits', 'policy-mode-plan'])
    for (const input of wrapper.findAll('input')) {
      expect(input.attributes('data-testid') ?? '').not.toMatch(/bypass/i)
      expect(input.attributes('value') ?? '').not.toMatch(/bypass/i)
    }
    expect(wrapper.get('[data-testid="policy-bypass-note"]').text()).toBe('admin.claudexPolicy.editor.bypassNote')
  })

  it('starts with every item inherited for an empty patch, controls disabled', () => {
    const wrapper = mountEditor()
    const boxes = wrapper.findAll('[data-testid="policy-inherit"]')
    expect(boxes.length).toBeGreaterThan(20)
    for (const box of boxes) expect((box.element as HTMLInputElement).checked).toBe(true)
    const fieldset = item(wrapper, 'incognito').get('fieldset')
    expect(fieldset.attributes('disabled')).toBeDefined()
    // Empty inherited domain lists say what they mean instead of showing an example.
    expect(
      item(wrapper, 'remote_image_domains').get('[data-testid="claudex-tag-input"]').attributes('placeholder')
    ).toBe('admin.claudexPolicy.editor.anyDomain')
    expect(
      item(wrapper, 'trusted_link_domains').get('[data-testid="claudex-tag-input"]').attributes('placeholder')
    ).toBe('admin.claudexPolicy.editor.noDomains')
  })

  it('writes an item only while it does not inherit, starting from the inherited value', async () => {
    const inherited = applyPatch(BUILTIN_POLICY, { incognito: false })
    const wrapper = mountEditor({ inherited })

    await uninherit(wrapper, 'incognito')
    expect(lastPatch(wrapper)).toEqual({ incognito: false })

    expect(item(wrapper, 'incognito').attributes('data-inherited')).toBe('false')
    await item(wrapper, 'incognito').get('button[role="switch"]').trigger('click')
    expect(lastPatch(wrapper)).toEqual({ incognito: true })
    expect(item(wrapper, 'incognito').get('button[role="switch"]').attributes('aria-checked')).toBe('true')

    await item(wrapper, 'incognito').get('[data-testid="policy-inherit"]').setValue(true)
    expect(lastPatch(wrapper)).toEqual({})
  })

  it('ignores changes to an inherited item', async () => {
    const wrapper = mountEditor()
    await item(wrapper, 'voice').get('button[role="switch"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('inherits link and attachment sub-fields one by one', async () => {
    const wrapper = mountEditor({ patch: { links: { help: 'https://help.example' } } })
    expect(
      (item(wrapper, 'links.help').get('[data-testid="policy-inherit"]').element as HTMLInputElement).checked
    ).toBe(false)
    expect(
      (item(wrapper, 'links.plans').get('[data-testid="policy-inherit"]').element as HTMLInputElement).checked
    ).toBe(true)

    await uninherit(wrapper, 'attachments.types')
    await item(wrapper, 'attachments.types').get('[data-testid="policy-type-png"]').setValue(false)
    const patch = lastPatch(wrapper)
    expect(patch.links).toEqual({ help: 'https://help.example' })
    expect(patch.attachments?.types).not.toContain('png')
    expect(patch.attachments).not.toHaveProperty('max_megabytes')
  })

  it('switches permission modes between one list and a list per platform, each needing a mode', async () => {
    const wrapper = mountEditor()
    await uninherit(wrapper, 'permission_modes')
    expect(lastPatch(wrapper)).toEqual({ permission_modes: ['auto', 'manual', 'acceptEdits', 'plan'] })

    await wrapper.get('[data-testid="policy-mode-auto"]').setValue(false)
    expect(lastPatch(wrapper)).toEqual({ permission_modes: ['manual', 'acceptEdits', 'plan'] })

    await wrapper.get('[data-testid="policy-per-platform"]').trigger('click')
    expect(lastPatch(wrapper)).toEqual({
      permission_modes: {
        darwin: ['manual', 'acceptEdits', 'plan'],
        win32: ['manual', 'acceptEdits', 'plan'],
        linux: ['manual', 'acceptEdits', 'plan']
      }
    })

    for (const mode of ['manual', 'acceptEdits', 'plan']) {
      await wrapper.get(`[data-testid="policy-mode-win32-${mode}"]`).setValue(false)
    }
    await wrapper.get('[data-testid="policy-mode-linux-acceptEdits"]').setValue(false)
    expect(lastPatch(wrapper).permission_modes).toEqual({
      darwin: ['manual', 'acceptEdits', 'plan'],
      win32: [],
      linux: ['manual', 'plan']
    })
    expect(wrapper.get('[data-testid="policy-modes-win32"]').text()).toContain(
      'admin.claudexPolicy.validation.empty_mode_list'
    )
    expect(wrapper.get('[data-testid="policy-modes-darwin"]').text()).not.toContain('validation')

    await wrapper.get('[data-testid="policy-mode-win32-plan"]').setValue(true)
    await wrapper.get('[data-testid="policy-per-platform"]').trigger('click')
    // Back to one list: the modes every platform had.
    expect(lastPatch(wrapper)).toEqual({ permission_modes: ['plan'] })
  })

  it('shows range problems next to the field', async () => {
    const wrapper = mountEditor()
    await uninherit(wrapper, 'usage_banner.warn_percent')
    expect(lastPatch(wrapper)).toEqual({ usage_banner: { warn_percent: 80 } })
    await wrapper.get('[data-testid="policy-warn-percent"]').setValue('0')
    expect(item(wrapper, 'usage_banner.warn_percent').get('[data-testid="policy-item-error"]').text()).toBe(
      'admin.claudexPolicy.validation.out_of_range{"min":1,"max":99}'
    )
    await wrapper.get('[data-testid="policy-warn-percent"]').setValue('90')
    expect(item(wrapper, 'usage_banner.warn_percent').find('[data-testid="policy-item-error"]').exists()).toBe(false)
    expect(lastPatch(wrapper)).toEqual({ usage_banner: { warn_percent: 90 } })

    await uninherit(wrapper, 'attachments.max_megabytes')
    await wrapper.get('[data-testid="policy-max-megabytes"]').setValue('25')
    expect(item(wrapper, 'attachments.max_megabytes').get('[data-testid="policy-item-error"]').text()).toBe(
      'admin.claudexPolicy.validation.megabytes'
    )
    await wrapper.get('[data-testid="policy-max-megabytes"]').setValue('')
    expect(lastPatch(wrapper).attachments).toEqual({ max_megabytes: null })

    await uninherit(wrapper, 'scheduled_tasks.max_tasks')
    await wrapper.get('[data-testid="policy-max-tasks"]').setValue('101')
    expect(item(wrapper, 'scheduled_tasks.max_tasks').get('[data-testid="policy-item-error"]').text()).toContain(
      'out_of_range'
    )
  })

  it('edits connectors as Any, Only these or None', async () => {
    const wrapper = mountEditor()
    await uninherit(wrapper, 'connectors')
    expect(lastPatch(wrapper)).toEqual({ connectors: null })
    expect((wrapper.get('[data-testid="policy-connectors-any"]').element as HTMLInputElement).checked).toBe(true)

    await wrapper.get('[data-testid="policy-connectors-only"]').setValue(true)
    expect(wrapper.findAll('[data-testid="policy-connector-row"]')).toHaveLength(1)
    await wrapper.get('[data-testid="policy-connector-name"]').setValue('bad name')
    expect(wrapper.get('[data-testid="policy-connector-row"]').text()).toContain(
      'admin.claudexPolicy.validation.invalid_name'
    )
    await wrapper.get('[data-testid="policy-connector-name"]').setValue('github')
    expect(wrapper.get('[data-testid="policy-connector-row"]').text()).not.toContain('invalid_name')
    expect(lastPatch(wrapper).connectors).toEqual([{ name: 'github', url_prefix: '', command: '' }])

    await wrapper.get('[data-testid="policy-connector-add"]').trigger('click')
    expect(wrapper.findAll('[data-testid="policy-connector-row"]')).toHaveLength(2)
    await wrapper.findAll('[data-testid="policy-connector-remove"]')[1].trigger('click')
    expect(wrapper.findAll('[data-testid="policy-connector-row"]')).toHaveLength(1)

    await wrapper.get('[data-testid="policy-connector-command"]').setValue('npx')
    await wrapper.get('[data-testid="policy-connector-args"]').setValue('-y\n@mcp/server-filesystem\n/tmp')
    expect(lastPatch(wrapper).connectors).toEqual([
      { name: 'github', url_prefix: '', command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] }
    ])
    await wrapper.get('[data-testid="policy-connector-command"]').setValue('')
    expect(wrapper.get('[data-testid="policy-connector-row"]').text()).toContain(
      'admin.claudexPolicy.validation.required'
    )
    await wrapper.get('[data-testid="policy-connector-args"]').setValue('')
    expect(lastPatch(wrapper).connectors).toEqual([{ name: 'github', url_prefix: '', command: '' }])

    await wrapper.get('[data-testid="policy-connectors-none"]').setValue(true)
    expect(lastPatch(wrapper)).toEqual({ connectors: [] })
  })

  it('shows remote image domains only while remote images are on', async () => {
    const off = mountEditor({ inherited: applyPatch(BUILTIN_POLICY, { remote_images: false }) })
    expect(off.find('[data-testid="policy-item-remote_image_domains"]').exists()).toBe(false)
    const on = mountEditor()
    expect(on.find('[data-testid="policy-item-remote_image_domains"]').exists()).toBe(true)
  })

  it('warns that attachments are off when no file type is selected', async () => {
    const wrapper = mountEditor({ patch: { attachments: { types: [] } } })
    expect(wrapper.find('[data-testid="policy-attachments-off"]').exists()).toBe(true)
  })

  it('offers the plan label for plan overrides only (or when a stored patch sets it)', () => {
    expect(mountEditor({ mode: 'plan' }).find('[data-testid="policy-item-plan_label"]').exists()).toBe(true)
    expect(mountEditor({ mode: 'defaults' }).find('[data-testid="policy-item-plan_label"]').exists()).toBe(false)
    expect(mountEditor({ mode: 'user' }).find('[data-testid="policy-item-plan_label"]').exists()).toBe(false)
    expect(
      mountEditor({ mode: 'user', patch: { plan_label: 'VIP' } })
        .find('[data-testid="policy-item-plan_label"]')
        .exists()
    ).toBe(true)
  })

  it('has sections for memory, Research, browser tools, SSH and computer use', () => {
    const wrapper = mountEditor({ mode: 'defaults' })
    for (const key of ['memory', 'research', 'browser', 'ssh', 'computerUse']) {
      expect(wrapper.find(`[data-testid="policy-section-${key}"]`).exists()).toBe(true)
    }
    for (const key of [
      'memory.enabled',
      'memory.default_on',
      'memory.model',
      'research.x_search',
      'research.max_searches_per_turn',
      'browser.external_sites',
      'browser.blocked_domains',
      'ssh_remote',
      'codex_runtime_mirror',
      'computer_use.enabled',
      'computer_use.denied_apps',
      'computer_use.max_actions_per_turn'
    ]) {
      expect(wrapper.find(`[data-testid="policy-item-${key}"]`).exists()).toBe(true)
    }
    // Computer use is off by default, so there is no warning yet.
    expect(wrapper.find('[data-testid="policy-computer-use-warning"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="policy-research-needs-web-search"]').exists()).toBe(false)
  })

  it('turns computer use on with its warning, and writes nested switches one by one', async () => {
    const wrapper = mountEditor({ mode: 'defaults' })
    await uninherit(wrapper, 'computer_use.enabled')
    expect(lastPatch(wrapper)).toEqual({ computer_use: { enabled: false } })
    await item(wrapper, 'computer_use.enabled').get('button[role="switch"]').trigger('click')
    expect(lastPatch(wrapper)).toEqual({ computer_use: { enabled: true } })
    expect(wrapper.find('[data-testid="policy-computer-use-warning"]').exists()).toBe(true)

    await uninherit(wrapper, 'computer_use.max_actions_per_turn')
    await wrapper.get('[data-testid="policy-max-actions"]').setValue('2000')
    expect(item(wrapper, 'computer_use.max_actions_per_turn').get('[data-testid="policy-item-error"]').text()).toContain(
      'out_of_range'
    )
    await wrapper.get('[data-testid="policy-max-actions"]').setValue('')
    expect(lastPatch(wrapper)).toEqual({ computer_use: { enabled: true, max_actions_per_turn: null } })
  })

  it('says Research is off while web search is off', () => {
    const wrapper = mountEditor({ inherited: applyPatch(BUILTIN_POLICY, { web_search: false }) })
    expect(wrapper.find('[data-testid="policy-research-needs-web-search"]').exists()).toBe(true)
  })

  it('an override adds to inherited deny lists and lists what it inherits', async () => {
    const inherited = applyPatch(BUILTIN_POLICY, {
      browser: { blocked_domains: ['mail.example.com'] },
      computer_use: { denied_apps: ['cmd.exe'] }
    })
    const wrapper = mountEditor({ inherited })
    // While inheriting, the list box itself shows the inherited entries (no second copy).
    expect(wrapper.find('[data-testid="policy-inherited-blocked-domains"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="policy-inherited-denied-apps"]').exists()).toBe(false)
    await uninherit(wrapper, 'browser.blocked_domains')
    expect(lastPatch(wrapper)).toEqual({ browser: { blocked_domains: [] } })
    expect(wrapper.get('[data-testid="policy-inherited-blocked-domains"]').text()).toContain('mail.example.com')
    await uninherit(wrapper, 'computer_use.denied_apps')
    expect(lastPatch(wrapper)).toEqual({ browser: { blocked_domains: [] }, computer_use: { denied_apps: [] } })
    expect(wrapper.get('[data-testid="policy-inherited-denied-apps"]').text()).toContain('cmd.exe')
  })

  it('an empty memory model box means the plan default (null)', async () => {
    const wrapper = mountEditor({ mode: 'defaults' })
    await uninherit(wrapper, 'memory.model')
    expect(lastPatch(wrapper)).toEqual({ memory: { model: null } })
    await wrapper.get('[data-testid="policy-memory-model"]').setValue('gpt 5')
    expect(item(wrapper, 'memory.model').get('[data-testid="policy-item-error"]').text()).toBe(
      'admin.claudexPolicy.validation.invalid_model'
    )
    await wrapper.get('[data-testid="policy-memory-model"]').setValue('gpt-5.5-mini')
    expect(lastPatch(wrapper)).toEqual({ memory: { model: 'gpt-5.5-mini' } })
    await wrapper.get('[data-testid="policy-memory-model"]').setValue('')
    expect(lastPatch(wrapper)).toEqual({ memory: { model: null } })
  })

  it('explains inherited values for user overrides and shows link fallbacks', () => {
    const wrapper = mountEditor({ mode: 'user', fallbacks: { doc_url: 'https://docs.example.com' } })
    expect(wrapper.find('[data-testid="policy-user-inherit-note"]').exists()).toBe(true)
    expect(item(wrapper, 'links.help').text()).toContain('https://docs.example.com')
    expect(item(wrapper, 'links.apps').text()).toContain('admin.claudexPolicy.editor.linkHidden')
    expect(mountEditor({ mode: 'plan' }).find('[data-testid="policy-user-inherit-note"]').exists()).toBe(false)
  })
})
