// CLAUDEX: tests for the voice (dictation) settings form model and checks (K4, owner decisions 18/19).
import { describe, expect, it } from 'vitest'

import {
  BYTES_PER_SECOND,
  audioSecondsToBytes,
  bytesToAudioSeconds,
  keyAvailable,
  validApiKey,
  validUpstreamUrl,
  validateVoiceForm,
  voiceFormFromSetting,
  voiceUpdateFromForm
} from '../voiceForm'
import type { VoiceSettingResponse } from '@/api/admin/claudex/voice'

const TEST_URL = 'wss://transcribe.example.com/v1/audio/realtime/transcriptions'

const stored: VoiceSettingResponse = {
  transcription: {
    enabled: true,
    upstream_url: TEST_URL,
    api_key_configured: true,
    api_key_masked: '********abcd',
    max_session_seconds: 300,
    max_bytes: 9_600_000,
    idle_timeout_seconds: 30
  },
  billing: {
    billed_model: 'realtime-transcription',
    bytes_per_second: 32000,
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    channels: 1,
    can_store_api_key: true
  },
  warnings: []
}

function form() {
  return voiceFormFromSetting(stored)
}

describe('voice form', () => {
  it('edits the audio limit in seconds and saves it in bytes of 16 kHz mono PCM', () => {
    expect(BYTES_PER_SECOND).toBe(32000)
    expect(bytesToAudioSeconds(9_600_000)).toBe(300)
    expect(audioSecondsToBytes(1.5)).toBe(48000)
    const f = form()
    expect(f.maxAudioSeconds).toBe(300)
    f.maxAudioSeconds = 120
    expect(voiceUpdateFromForm(f).transcription.max_bytes).toBe(120 * 32000)
  })

  it('saves an untouched audio limit unchanged even when it is not a whole number of seconds', () => {
    const f = voiceFormFromSetting({ ...stored, transcription: { ...stored.transcription, max_bytes: 32_001 } })
    expect(f.maxAudioSeconds).toBe(1)
    expect(voiceUpdateFromForm(f).transcription.max_bytes).toBe(32_001)
    expect(validateVoiceForm(f)).toEqual({})
  })

  it('sends every setting but never a key unless one was typed in', () => {
    expect(voiceUpdateFromForm(form())).toEqual({
      transcription: {
        enabled: true,
        upstream_url: TEST_URL,
        max_session_seconds: 300,
        max_bytes: 9_600_000,
        idle_timeout_seconds: 30
      }
    })
  })

  it('shows the stored key only masked and keeps the typed key out of the loaded form', () => {
    const f = form()
    expect(f.apiKey).toBe('')
    expect(f.keyConfigured).toBe(true)
    expect(f.keyMasked).toBe('********abcd')
    const none = voiceFormFromSetting({
      ...stored,
      transcription: { ...stored.transcription, api_key_configured: false, api_key_masked: 'x' }
    })
    expect(none.keyMasked).toBe('')
  })

  it('sends a new key trimmed, or clear_api_key, never both', () => {
    const f = form()
    f.apiKey = '  sk-new-key-12345  '
    expect(voiceUpdateFromForm(f).transcription.api_key).toBe('sk-new-key-12345')
    expect(voiceUpdateFromForm(f).transcription).not.toHaveProperty('clear_api_key')

    f.clearKey = true
    expect(voiceUpdateFromForm(f).transcription).not.toHaveProperty('clear_api_key')

    f.apiKey = ''
    expect(voiceUpdateFromForm(f).transcription.clear_api_key).toBe(true)
    expect(voiceUpdateFromForm(f).transcription).not.toHaveProperty('api_key')
  })

  it('fills missing values with the server defaults (off, no key, no service)', () => {
    const f = voiceFormFromSetting(null)
    expect(f.enabled).toBe(false)
    expect(f.keyConfigured).toBe(false)
    expect(f.upstreamUrl).toBe('')
    expect(voiceUpdateFromForm(f).transcription).toMatchObject({
      max_session_seconds: 300,
      max_bytes: 300 * 32000,
      idle_timeout_seconds: 30
    })
    expect(validateVoiceForm(f)).toEqual({})
  })

  it('needs a key before dictation can be on', () => {
    const f = voiceFormFromSetting(null)
    f.enabled = true
    f.upstreamUrl = TEST_URL
    expect(keyAvailable(f)).toBe(false)
    expect(validateVoiceForm(f)).toEqual({ 'transcription.api_key': 'keyRequired' })
    f.apiKey = 'sk-12345678'
    expect(validateVoiceForm(f)).toEqual({})

    const g = form()
    g.clearKey = true
    expect(validateVoiceForm(g)).toEqual({ 'transcription.api_key': 'keyRequired' })
    g.enabled = false
    expect(validateVoiceForm(g)).toEqual({})
  })

  it('checks every range the server checks', () => {
    const f = form()
    f.upstreamUrl = 'https://example.com/asr'
    f.apiKey = 'short'
    f.maxSessionSeconds = 9
    f.maxAudioSeconds = 3601
    f.idleTimeoutSeconds = 301
    expect(validateVoiceForm(f)).toEqual({
      'transcription.upstream_url': 'upstreamUrl',
      'transcription.api_key': 'apiKey',
      'transcription.max_session_seconds': 'sessionSeconds',
      'transcription.max_bytes': 'audioSeconds',
      'transcription.idle_timeout_seconds': 'idleSeconds'
    })
  })

  it.each([
    [10, true],
    [3600, true],
    [3601, false],
    [60.5, false],
    [null, false]
  ])('max session seconds %j valid: %s', (seconds, valid) => {
    const f = form()
    f.maxSessionSeconds = seconds
    expect('transcription.max_session_seconds' in validateVoiceForm(f)).toBe(!valid)
  })

  it.each([
    [1, true],
    [3600, true],
    [0.5, false],
    [0, false],
    ['', false],
    [3600.5, false]
  ])('max audio %j seconds valid: %s', (seconds, valid) => {
    const f = form()
    f.maxAudioSeconds = seconds
    expect('transcription.max_bytes' in validateVoiceForm(f)).toBe(!valid)
  })

  it.each([
    [5, true],
    [300, true],
    [4, false],
    [30.5, false]
  ])('idle timeout %j valid: %s', (seconds, valid) => {
    const f = form()
    f.idleTimeoutSeconds = seconds
    expect('transcription.idle_timeout_seconds' in validateVoiceForm(f)).toBe(!valid)
  })

  it.each([
    ['wss://transcribe.example.com/v1/audio/realtime/transcriptions', true],
    ['  wss://asr.example.com:8443/path?lang=en  ', true],
    ['ws://localhost:9000/asr', true],
    ['ws://127.0.0.1:9000/asr', true],
    ['ws://[::1]:9000/asr', true],
    ['ws://asr.example.com/asr', false],
    ['https://asr.example.com/asr', false],
    ['wss://user:pass@asr.example.com/asr', false],
    ['wss://asr.example.com/asr#frag', false],
    ['wss://asr.example.com/asr?api_key=secret', false],
    ['wss://asr.example.com/asr?Token=secret', false],
    ['wss://asr.example.com/asr?key=secret', false],
    ['not a url', false],
    ['', false],
    [`wss://asr.example.com/${'a'.repeat(2048)}`, false]
  ])('upstream URL %j valid: %s', (url, valid) => {
    expect(validUpstreamUrl(url)).toBe(valid)
  })

  it.each([
    ['sk-12345678', true],
    ['  sk-12345678  ', true],
    ['k'.repeat(512), true],
    ['k'.repeat(513), false],
    ['1234567', false],
    ['sk 12345678', false],
    ['sk-1234\u00005678', false]
  ])('API key %j valid: %s', (key, valid) => {
    expect(validApiKey(key)).toBe(valid)
  })
})
