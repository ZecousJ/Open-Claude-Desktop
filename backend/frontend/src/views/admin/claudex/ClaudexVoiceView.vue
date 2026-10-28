<!--
  CLAUDEX: /admin/claudex/voice (design 3.2 K4, server 2.8 as rescoped by
  owner decisions 18/19). Dictation in the desktop app: the gateway relays
  microphone audio to a realtime transcription service over WebSocket with
  the API key stored here (write-only, shown masked). Also the limits of a
  session, how sessions are billed, the server's warnings and the session
  list. There is no read aloud (owner decision 19).
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexVoice.title')"
    :description="t('admin.claudexVoice.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-voice-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div v-if="warnings.length" class="space-y-2" data-testid="claudex-voice-warnings">
        <div
          v-for="(warning, index) in warnings"
          :key="index"
          role="status"
          class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
          data-testid="claudex-voice-warning"
        >
          <Icon name="exclamationTriangle" size="sm" class="mt-0.5 flex-shrink-0" />
          <span>{{ warning }}</span>
        </div>
      </div>

      <div class="card" data-testid="claudex-voice-transcription">
        <div class="flex items-start justify-between gap-6 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <div class="min-w-0">
            <h3 id="claudex-voice-transcription-title" class="text-base font-semibold text-gray-900 dark:text-white">
              {{ t('admin.claudexVoice.transcription.title') }}
            </h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexVoice.transcription.description') }}
            </p>
          </div>
          <Toggle
            v-model="form.enabled"
            aria-labelledby="claudex-voice-transcription-title"
            data-testid="claudex-voice-enabled"
          />
        </div>

        <div class="space-y-5 p-6">
          <div>
            <label for="claudex-voice-upstream-url" class="input-label mb-1.5 block">
              {{ t('admin.claudexVoice.upstreamUrl') }}
            </label>
            <input
              id="claudex-voice-upstream-url"
              v-model="form.upstreamUrl"
              type="url"
              autocomplete="off"
              spellcheck="false"
              :maxlength="UPSTREAM_URL_MAX_LENGTH"
              class="input w-full font-mono text-sm"
              :class="{ 'input-error': show('transcription.upstream_url') }"
              data-testid="claudex-voice-upstream-url"
            />
            <p v-if="show('transcription.upstream_url')" class="input-error-text mt-1.5">
              {{ problemText('transcription.upstream_url') }}
            </p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexVoice.upstreamUrlHint') }}</p>
          </div>

          <div data-testid="claudex-voice-key">
            <label for="claudex-voice-api-key" class="input-label mb-1.5 block">{{ t('admin.claudexVoice.apiKey') }}</label>
            <div class="mb-2 flex flex-wrap items-center gap-2 text-sm" data-testid="claudex-voice-key-status">
              <template v-if="form.clearKey">
                <span class="text-amber-700 dark:text-amber-300">{{ t('admin.claudexVoice.keyWillBeRemoved') }}</span>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="claudex-voice-key-undo"
                  @click="undoRemoveKey"
                >
                  {{ t('admin.claudexVoice.undoRemoveKey') }}
                </button>
              </template>
              <template v-else-if="form.keyConfigured">
                <span class="text-gray-600 dark:text-gray-300">{{ t('admin.claudexVoice.keyStored') }}</span>
                <code
                  v-if="form.keyMasked"
                  class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-dark-700 dark:text-gray-300"
                  data-testid="claudex-voice-key-masked"
                  >{{ form.keyMasked }}</code
                >
                <button
                  type="button"
                  class="btn btn-ghost btn-sm text-red-600 dark:text-red-400"
                  data-testid="claudex-voice-key-remove"
                  @click="removeKey"
                >
                  {{ t('admin.claudexVoice.removeKey') }}
                </button>
              </template>
              <span v-else class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexVoice.keyNotStored') }}</span>
            </div>
            <input
              id="claudex-voice-api-key"
              v-model="form.apiKey"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              :maxlength="API_KEY_MAX_LENGTH"
              class="input w-full font-mono text-sm"
              :class="{ 'input-error': show('transcription.api_key') }"
              :disabled="!canStoreKey"
              :placeholder="
                form.keyConfigured && !form.clearKey
                  ? t('admin.claudexVoice.apiKeyReplacePlaceholder')
                  : t('admin.claudexVoice.apiKeyPlaceholder')
              "
              data-testid="claudex-voice-api-key"
            />
            <p v-if="show('transcription.api_key')" class="input-error-text mt-1.5">
              {{ problemText('transcription.api_key') }}
            </p>
            <p v-else-if="!canStoreKey" class="input-hint mt-1.5">{{ t('admin.claudexVoice.cannotStoreKey') }}</p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexVoice.apiKeyHint') }}</p>
          </div>

          <div class="grid gap-5 md:grid-cols-3">
            <div>
              <label for="claudex-voice-session-seconds" class="input-label mb-1.5 block">
                {{ t('admin.claudexVoice.maxSession') }}
              </label>
              <input
                id="claudex-voice-session-seconds"
                v-model.number="form.maxSessionSeconds"
                type="number"
                :min="MIN_SESSION_SECONDS"
                :max="MAX_SESSION_SECONDS"
                step="1"
                class="input w-full"
                :class="{ 'input-error': show('transcription.max_session_seconds') }"
                data-testid="claudex-voice-session-seconds"
              />
              <p v-if="show('transcription.max_session_seconds')" class="input-error-text mt-1.5">
                {{ problemText('transcription.max_session_seconds') }}
              </p>
              <p v-else class="input-hint mt-1.5">{{ t('admin.claudexVoice.maxSessionHint') }}</p>
            </div>
            <div>
              <label for="claudex-voice-audio-seconds" class="input-label mb-1.5 block">
                {{ t('admin.claudexVoice.maxAudio') }}
              </label>
              <input
                id="claudex-voice-audio-seconds"
                v-model.number="form.maxAudioSeconds"
                type="number"
                :min="MIN_AUDIO_SECONDS"
                :max="MAX_AUDIO_SECONDS"
                step="1"
                class="input w-full"
                :class="{ 'input-error': show('transcription.max_bytes') }"
                data-testid="claudex-voice-audio-seconds"
              />
              <p v-if="show('transcription.max_bytes')" class="input-error-text mt-1.5">
                {{ problemText('transcription.max_bytes') }}
              </p>
              <p v-else class="input-hint mt-1.5">{{ t('admin.claudexVoice.maxAudioHint') }}</p>
            </div>
            <div>
              <label for="claudex-voice-idle-seconds" class="input-label mb-1.5 block">
                {{ t('admin.claudexVoice.idleTimeout') }}
              </label>
              <input
                id="claudex-voice-idle-seconds"
                v-model.number="form.idleTimeoutSeconds"
                type="number"
                :min="MIN_IDLE_SECONDS"
                :max="MAX_IDLE_SECONDS"
                step="1"
                class="input w-full"
                :class="{ 'input-error': show('transcription.idle_timeout_seconds') }"
                data-testid="claudex-voice-idle-seconds"
              />
              <p v-if="show('transcription.idle_timeout_seconds')" class="input-error-text mt-1.5">
                {{ problemText('transcription.idle_timeout_seconds') }}
              </p>
              <p v-else class="input-hint mt-1.5">{{ t('admin.claudexVoice.idleTimeoutHint') }}</p>
            </div>
          </div>

          <p v-if="billing" class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-voice-billing">
            {{
              t('admin.claudexVoice.billing', {
                model: billing.billed_model,
                bytes: billing.bytes_per_second,
                format: billing.audio_format,
                rate: billing.sample_rate,
                channels: billing.channels
              })
            }}
          </p>
        </div>
      </div>

      <SaveBar
        :saving="save.saving.value"
        :dirty="dirty"
        :saved="save.saved.value"
        :error="formError || save.error.value"
        :disabled="!dirty"
        @save="submit"
      />

      <VoiceSessionList />
    </template>

    <TotpStepUpDialog :controller="stepUp" />
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ClaudexUnavailable from '@/components/admin/claudex/common/ClaudexUnavailable.vue'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { isMissingEndpoint, runWithStepUp, snapshot } from '@/components/admin/claudex/general/pageSupport'
import VoiceSessionList from '@/components/admin/claudex/voice/VoiceSessionList.vue'
import {
  API_KEY_MAX_LENGTH,
  MAX_AUDIO_SECONDS,
  MAX_IDLE_SECONDS,
  MAX_SESSION_SECONDS,
  MIN_AUDIO_SECONDS,
  MIN_IDLE_SECONDS,
  MIN_SESSION_SECONDS,
  UPSTREAM_URL_MAX_LENGTH,
  validateVoiceForm,
  voiceFormFromSetting,
  voiceUpdateFromForm,
  type VoiceForm
} from '@/components/admin/claudex/voice/voiceForm'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Toggle from '@/components/common/Toggle.vue'
import Icon from '@/components/icons/Icon.vue'
import { getVoice, updateVoice, type VoiceBillingView, type VoiceSettingResponse } from '@/api/admin/claudex/voice'
import { useStepUp } from '@/composables/useStepUp'

const { t, te } = useI18n()
const stepUp = useStepUp()
const save = useClaudexSave('claudexVoice')

const loading = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const loaded = ref(false)
const form = ref<VoiceForm>(voiceFormFromSetting(null))
const baseline = ref('')
const warnings = ref<string[]>([])
const billing = ref<VoiceBillingView | null>(null)
const formError = ref<string | null>(null)

// An older server doesn't send billing; assume it can store a key and let it answer.
const canStoreKey = computed(() => billing.value?.can_store_api_key !== false)
const problems = computed(() => validateVoiceForm(form.value))
const current = computed(() => snapshot(voiceUpdateFromForm(form.value)))
const dirty = computed(() => loaded.value && current.value !== baseline.value)

watch(
  form,
  () => {
    formError.value = null
    if (dirty.value) save.reset()
  },
  { deep: true }
)

function show(field: string): boolean {
  return Boolean(problems.value[field])
}

function problemText(field: string): string {
  const problem = problems.value[field]
  return problem ? t(`admin.claudexVoice.problems.${problem}`) : ''
}

// The switch position before Remove key, so Undo puts it back.
let enabledBeforeRemove = false

/** Removing the stored key turns dictation off (the server does the same). */
function removeKey() {
  enabledBeforeRemove = form.value.enabled
  form.value.clearKey = true
  form.value.apiKey = ''
  form.value.enabled = false
}

function undoRemoveKey() {
  form.value.clearKey = false
  form.value.enabled = enabledBeforeRemove
}

function apply(setting: VoiceSettingResponse) {
  form.value = voiceFormFromSetting(setting)
  baseline.value = snapshot(voiceUpdateFromForm(form.value))
  warnings.value = Array.isArray(setting.warnings) ? setting.warnings.filter((w) => typeof w === 'string' && w) : []
  billing.value = setting.billing && typeof setting.billing === 'object' ? setting.billing : null
}

async function load() {
  loading.value = true
  loadError.value = null
  unavailable.value = false
  try {
    apply(await getVoice())
    loaded.value = true
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexVoice', t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (Object.keys(problems.value).length > 0) {
    formError.value = t('admin.claudexVoice.fixProblems')
    return
  }
  const body = voiceUpdateFromForm(form.value)
  const result = await save.run(() => runWithStepUp(stepUp, () => updateVoice(body), t))
  if (result.ok) {
    apply(result.value)
  }
}

onMounted(load)
</script>
