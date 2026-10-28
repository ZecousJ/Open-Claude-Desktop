// CLAUDEX: tests for the Claudex console voice (dictation) page (K4, owner decisions 18/19).
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexVoiceView from '../ClaudexVoiceView.vue'

const { getVoice, updateVoice, listVoiceSessions } = vi.hoisted(() => ({
  getVoice: vi.fn(),
  updateVoice: vi.fn(),
  listVoiceSessions: vi.fn()
}))

vi.mock('@/api/admin/claudex/voice', () => ({ getVoice, updateVoice, listVoiceSessions }))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) =>
      key === 'admin.claudexVoice.errors.CLAUDEX_VOICE_INVALID' ||
      key === 'admin.claudexVoice.sessions.endReasons.finished'
  })
}))

vi.mock('@/components/layout/AppLayout.vue', () => ({
  default: defineComponent({
    name: 'AppLayout',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    }
  })
}))

vi.mock('@/components/auth/TotpStepUpDialog.vue', () => ({
  default: defineComponent({
    name: 'TotpStepUpDialog',
    props: { controller: { type: Object, required: true } },
    setup() {
      return () => h('div')
    }
  })
}))

const URL = 'wss://transcribe.example.com/v1/audio/realtime/transcriptions'

const billing = {
  billed_model: 'realtime-transcription',
  bytes_per_second: 32000,
  audio_format: 'pcm_s16le',
  sample_rate: 16000,
  channels: 1,
  can_store_api_key: true
}

const stored = {
  transcription: {
    enabled: true,
    upstream_url: URL,
    api_key_configured: true,
    api_key_masked: '********abcd',
    max_session_seconds: 300,
    max_bytes: 9_600_000,
    idle_timeout_seconds: 30
  },
  billing,
  warnings: ['Group claudex-pro has no audio_stt_price_per_hour; dictation uses the built-in default price ($0.10/hour).']
}

const sessions = {
  items: [
    {
      request_id: 'claudex_audio:req_123',
      user_id: 7,
      user_email: 'ann@example.com',
      api_key_id: 3,
      group_id: 2,
      audio_bytes: 3_840_000,
      estimated_seconds: 120,
      cost_usd: 0.0033,
      billed: true,
      duration_ms: 125_000,
      end_reason: 'finished',
      created_at: '2026-09-25T10:00:00Z'
    },
    {
      request_id: 'claudex_audio:req_124',
      user_id: 8,
      user_email: null,
      audio_bytes: 64_000,
      estimated_seconds: 2,
      cost_usd: 0,
      billed: false,
      duration_ms: 3_000,
      end_reason: 'something_new',
      created_at: '2026-09-25T10:01:00Z'
    }
  ],
  total: 2,
  page: 1,
  page_size: 20,
  pages: 1
}

function mountView() {
  return mount(ClaudexVoiceView, { global: { stubs: { Icon: true } } })
}

async function loaded(setting: unknown = stored) {
  getVoice.mockResolvedValue(setting)
  listVoiceSessions.mockResolvedValue(sessions)
  const wrapper = mountView()
  await flushPromises()
  return wrapper
}

function el(wrapper: ReturnType<typeof mountView>, id: string) {
  return wrapper.get(`[data-testid="${id}"]`)
}

async function clickSave(wrapper: ReturnType<typeof mountView>) {
  await el(wrapper, 'claudex-save-button').trigger('click')
  await flushPromises()
}

describe('ClaudexVoiceView', () => {
  beforeEach(() => {
    getVoice.mockReset()
    updateVoice.mockReset()
    listVoiceSessions.mockReset()
  })

  it('shows the dictation settings, the masked key, the billing note and the warnings', async () => {
    const wrapper = await loaded()
    expect(el(wrapper, 'claudex-voice-enabled').attributes('aria-checked')).toBe('true')
    expect((el(wrapper, 'claudex-voice-upstream-url').element as HTMLInputElement).value).toBe(URL)
    expect(el(wrapper, 'claudex-voice-key-masked').text()).toBe('********abcd')
    const keyInput = el(wrapper, 'claudex-voice-api-key').element as HTMLInputElement
    expect(keyInput.type).toBe('password')
    expect(keyInput.value).toBe('')
    expect(keyInput.placeholder).toBe('admin.claudexVoice.apiKeyReplacePlaceholder')
    expect((el(wrapper, 'claudex-voice-session-seconds').element as HTMLInputElement).value).toBe('300')
    expect((el(wrapper, 'claudex-voice-audio-seconds').element as HTMLInputElement).value).toBe('300')
    expect((el(wrapper, 'claudex-voice-idle-seconds').element as HTMLInputElement).value).toBe('30')
    expect(el(wrapper, 'claudex-voice-billing').text()).toContain('"model":"realtime-transcription"')
    const warnings = wrapper.findAll('[data-testid="claudex-voice-warning"]')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].classes()).toContain('bg-amber-50')
  })

  it('has no read-aloud settings (owner decision 19)', async () => {
    const wrapper = await loaded()
    expect(wrapper.find('[data-testid="claudex-voice-speech"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-voice-tts-voices"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-voice-tts-chars"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/speech|readAloud|defaultVoice/)
  })

  it('lists the dictation sessions with the 32 000 bytes per second explanation', async () => {
    const wrapper = await loaded()
    const card = el(wrapper, 'claudex-voice-sessions')
    expect(card.text()).toContain('admin.claudexVoice.sessions.description')
    expect(card.text()).toContain('claudex_audio:req_123')
    expect(card.text()).toContain('ann@example.com')
    expect(card.text()).toContain('#8')
    expect(card.text()).toContain('admin.claudexVoice.sessions.minutesSeconds{"minutes":2,"seconds":0}')
    expect(card.text()).toContain('admin.claudexVoice.sessions.minutesSeconds{"minutes":2,"seconds":5}')
    expect(card.text()).toContain('admin.claudexVoice.sessions.endReasons.finished')
    // An end reason the page doesn't know is shown as sent.
    expect(card.text()).toContain('something_new')
    expect(card.text()).toContain('admin.claudexVoice.sessions.notBilled')
    expect(listVoiceSessions).toHaveBeenCalledWith({ user_id: undefined, page: 1, page_size: 20 })

    await el(wrapper, 'claudex-voice-sessions-user').setValue('7')
    await el(wrapper, 'claudex-voice-sessions-filter').trigger('submit')
    await flushPromises()
    expect(listVoiceSessions).toHaveBeenLastCalledWith({ user_id: 7, page: 1, page_size: 20 })
  })

  it('saves the limits (audio in bytes) without sending the stored key', async () => {
    const wrapper = await loaded()
    updateVoice.mockResolvedValue({ ...stored, warnings: [] })
    await el(wrapper, 'claudex-voice-session-seconds').setValue('600')
    await el(wrapper, 'claudex-voice-audio-seconds').setValue('120')
    await el(wrapper, 'claudex-voice-idle-seconds').setValue('20')
    await clickSave(wrapper)

    expect(updateVoice).toHaveBeenCalledWith({
      transcription: {
        enabled: true,
        upstream_url: URL,
        max_session_seconds: 600,
        max_bytes: 120 * 32000,
        idle_timeout_seconds: 20
      }
    })
    // The fresh GET shape replaces the warnings.
    expect(wrapper.find('[data-testid="claudex-voice-warning"]').exists()).toBe(false)
    expect(el(wrapper, 'claudex-save-status').text()).toBe('admin.claudex.common.saved')
  })

  it('stores a new key and clears the field after saving', async () => {
    const noKey = {
      ...stored,
      transcription: { ...stored.transcription, enabled: false, api_key_configured: false, api_key_masked: '' }
    }
    const wrapper = await loaded(noKey)
    expect(el(wrapper, 'claudex-voice-key-status').text()).toBe('admin.claudexVoice.keyNotStored')

    // Turning dictation on without a key is refused.
    await el(wrapper, 'claudex-voice-enabled').trigger('click')
    await clickSave(wrapper)
    expect(updateVoice).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('admin.claudexVoice.problems.keyRequired')

    updateVoice.mockResolvedValue({
      ...stored,
      transcription: { ...stored.transcription, api_key_masked: '********wxyz' }
    })
    await el(wrapper, 'claudex-voice-api-key').setValue('sk-live-0123456789wxyz')
    await clickSave(wrapper)
    expect(updateVoice).toHaveBeenCalledWith({
      transcription: expect.objectContaining({ enabled: true, api_key: 'sk-live-0123456789wxyz' })
    })
    expect((el(wrapper, 'claudex-voice-api-key').element as HTMLInputElement).value).toBe('')
    expect(el(wrapper, 'claudex-voice-key-masked').text()).toBe('********wxyz')
    expect(wrapper.text()).not.toContain('sk-live-0123456789wxyz')
  })

  it('removes the stored key (turning dictation off) and can undo', async () => {
    const wrapper = await loaded()
    await el(wrapper, 'claudex-voice-key-remove').trigger('click')
    expect(el(wrapper, 'claudex-voice-enabled').attributes('aria-checked')).toBe('false')
    expect(el(wrapper, 'claudex-voice-key-status').text()).toContain('admin.claudexVoice.keyWillBeRemoved')

    await el(wrapper, 'claudex-voice-key-undo').trigger('click')
    expect(el(wrapper, 'claudex-voice-key-masked').exists()).toBe(true)
    expect(el(wrapper, 'claudex-voice-enabled').attributes('aria-checked')).toBe('true')
    // Nothing left to save after undoing.
    expect(el(wrapper, 'claudex-save-button').attributes('disabled')).toBeDefined()

    await el(wrapper, 'claudex-voice-key-remove').trigger('click')
    updateVoice.mockResolvedValue({
      ...stored,
      transcription: { ...stored.transcription, enabled: false, api_key_configured: false, api_key_masked: '' }
    })
    await clickSave(wrapper)
    expect(updateVoice).toHaveBeenCalledWith({
      transcription: expect.objectContaining({ enabled: false, clear_api_key: true })
    })
    expect(updateVoice.mock.calls[0][0].transcription).not.toHaveProperty('api_key')
    expect(el(wrapper, 'claudex-voice-key-status').text()).toBe('admin.claudexVoice.keyNotStored')
  })

  it('does not save invalid values', async () => {
    const wrapper = await loaded()
    await el(wrapper, 'claudex-voice-upstream-url').setValue('https://example.com/asr')
    await el(wrapper, 'claudex-voice-idle-seconds').setValue('500')
    await clickSave(wrapper)
    expect(updateVoice).not.toHaveBeenCalled()
    expect(el(wrapper, 'claudex-save-error').text()).toBe('admin.claudexVoice.fixProblems')
    expect(wrapper.text()).toContain('admin.claudexVoice.problems.upstreamUrl')
    expect(wrapper.text()).toContain('admin.claudexVoice.problems.idleSeconds')
  })

  it('disables the key field when the server cannot store a key', async () => {
    const wrapper = await loaded({ ...stored, billing: { ...billing, can_store_api_key: false } })
    expect(el(wrapper, 'claudex-voice-api-key').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('admin.claudexVoice.cannotStoreKey')
  })

  it('maps CLAUDEX_VOICE_INVALID to the page message', async () => {
    const wrapper = await loaded()
    updateVoice.mockRejectedValue({ status: 400, reason: 'CLAUDEX_VOICE_INVALID', message: 'bad' })
    await el(wrapper, 'claudex-voice-session-seconds').setValue('900')
    await clickSave(wrapper)
    expect(el(wrapper, 'claudex-save-error').text()).toBe('admin.claudexVoice.errors.CLAUDEX_VOICE_INVALID')
  })

  it('says the page is not in this build when the server has no such endpoint', async () => {
    getVoice.mockRejectedValue({ status: 404 })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(true)
    expect(listVoiceSessions).not.toHaveBeenCalled()
  })
})
