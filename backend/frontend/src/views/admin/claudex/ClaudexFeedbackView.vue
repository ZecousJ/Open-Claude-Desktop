<!--
  CLAUDEX: /admin/claudex/feedback (design 3.2 K4, server 2.9, owner
  decision 1). Settings for diagnostics and reply feedback (both off by
  default; saving goes through step-up) and the two inboxes. Nothing is
  collected until an admin turns a kind on, and each user must also agree in
  the Claudex app; prompts are never included unless the user attaches the
  conversation to a feedback and excerpts are allowed here.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexFeedback.title')"
    :description="t('admin.claudexFeedback.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-feedback-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div
        class="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800/50 dark:bg-blue-900/20"
        data-testid="claudex-feedback-consent-note"
      >
        <Icon name="infoCircle" size="md" class="mt-0.5 flex-shrink-0 text-blue-500" />
        <div class="text-sm text-blue-800 dark:text-blue-200">
          <p class="font-medium">{{ t('admin.claudexFeedback.consentNote') }}</p>
          <p class="mt-1 text-blue-700 dark:text-blue-300">
            {{ collecting ? t('admin.claudexFeedback.collecting') : t('admin.claudexFeedback.notCollecting') }}
          </p>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="card" data-testid="claudex-feedback-diagnostics-settings">
          <div class="flex items-start justify-between gap-6 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
            <div class="min-w-0">
              <h3 id="claudex-feedback-diagnostics-title" class="text-base font-semibold text-gray-900 dark:text-white">
                {{ t('admin.claudexFeedback.diagnostics.title') }}
              </h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('admin.claudexFeedback.diagnostics.description') }}
              </p>
            </div>
            <Toggle
              v-model="form.diagnostics.enabled"
              aria-labelledby="claudex-feedback-diagnostics-title"
              data-testid="claudex-feedback-diagnostics-enabled"
            />
          </div>
          <div class="grid gap-5 p-6 sm:grid-cols-2">
            <div>
              <label for="claudex-diag-retention" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.retentionDays') }}</label>
              <input
                id="claudex-diag-retention"
                v-model.number="form.diagnostics.retentionDays"
                type="number"
                min="1"
                :max="DIAGNOSTICS_RETENTION_MAX"
                step="1"
                class="input w-full"
                :class="{ 'input-error': problems['diagnostics.retention_days'] }"
                data-testid="claudex-diag-retention"
              />
              <p v-if="problems['diagnostics.retention_days']" class="input-error-text mt-1.5">
                {{ problemText('diagnostics.retention_days') }}
              </p>
            </div>
            <div>
              <label for="claudex-diag-per-day" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.perDay') }}</label>
              <input
                id="claudex-diag-per-day"
                v-model.number="form.diagnostics.maxPerUserPerDay"
                type="number"
                min="1"
                :max="PER_DAY_MAX"
                step="1"
                class="input w-full"
                :class="{ 'input-error': problems['diagnostics.max_per_user_per_day'] }"
                data-testid="claudex-diag-per-day"
              />
              <p v-if="problems['diagnostics.max_per_user_per_day']" class="input-error-text mt-1.5">
                {{ problemText('diagnostics.max_per_user_per_day') }}
              </p>
            </div>
          </div>
        </div>

        <div class="card" data-testid="claudex-feedback-feedback-settings">
          <div class="flex items-start justify-between gap-6 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
            <div class="min-w-0">
              <h3 id="claudex-feedback-feedback-title" class="text-base font-semibold text-gray-900 dark:text-white">
                {{ t('admin.claudexFeedback.feedback.title') }}
              </h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('admin.claudexFeedback.feedback.description') }}
              </p>
            </div>
            <Toggle
              v-model="form.feedback.enabled"
              aria-labelledby="claudex-feedback-feedback-title"
              data-testid="claudex-feedback-feedback-enabled"
            />
          </div>
          <div class="grid gap-5 p-6 sm:grid-cols-2">
            <div>
              <label for="claudex-fb-retention" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.retentionDays') }}</label>
              <input
                id="claudex-fb-retention"
                v-model.number="form.feedback.retentionDays"
                type="number"
                min="1"
                :max="FEEDBACK_RETENTION_MAX"
                step="1"
                class="input w-full"
                :class="{ 'input-error': problems['feedback.retention_days'] }"
                data-testid="claudex-fb-retention"
              />
              <p v-if="problems['feedback.retention_days']" class="input-error-text mt-1.5">
                {{ problemText('feedback.retention_days') }}
              </p>
            </div>
            <div>
              <label for="claudex-fb-per-day" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.perDay') }}</label>
              <input
                id="claudex-fb-per-day"
                v-model.number="form.feedback.maxPerUserPerDay"
                type="number"
                min="1"
                :max="PER_DAY_MAX"
                step="1"
                class="input w-full"
                :class="{ 'input-error': problems['feedback.max_per_user_per_day'] }"
                data-testid="claudex-fb-per-day"
              />
              <p v-if="problems['feedback.max_per_user_per_day']" class="input-error-text mt-1.5">
                {{ problemText('feedback.max_per_user_per_day') }}
              </p>
            </div>
            <div class="flex items-start justify-between gap-6 sm:col-span-2">
              <div class="min-w-0">
                <p id="claudex-fb-excerpt-label" class="text-sm font-medium text-gray-900 dark:text-white">
                  {{ t('admin.claudexFeedback.feedback.allowExcerpt') }}
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {{ t('admin.claudexFeedback.feedback.allowExcerptHint') }}
                </p>
              </div>
              <Toggle
                v-model="form.feedback.allowConversationExcerpt"
                aria-labelledby="claudex-fb-excerpt-label"
                data-testid="claudex-feedback-allow-excerpt"
              />
            </div>
          </div>
        </div>
      </div>

      <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('admin.claudexFeedback.retentionNote') }}</p>

      <SaveBar
        :saving="save.saving.value"
        :dirty="dirty"
        :saved="save.saved.value"
        :error="formError || save.error.value"
        :disabled="!dirty"
        @save="submit"
      />

      <div class="card" data-testid="claudex-feedback-inboxes">
        <div class="border-b border-gray-100 px-6 dark:border-dark-700">
          <nav class="-mb-px flex gap-6" role="tablist">
            <button
              v-for="tab in tabs"
              :id="`claudex-feedback-tab-${tab}`"
              :key="tab"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab"
              :aria-controls="`claudex-feedback-panel-${tab}`"
              class="border-b-2 py-3 text-sm font-medium"
              :class="
                activeTab === tab
                  ? 'border-primary-600 text-primary-600 dark:border-primary-400 dark:text-primary-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              "
              :data-testid="`claudex-feedback-tab-${tab}`"
              @click="activeTab = tab"
            >
              {{ tab === 'diagnostics' ? t('admin.claudexFeedback.tabs.diagnostics') : t('admin.claudexFeedback.tabs.feedback') }}
            </button>
          </nav>
        </div>
        <div
          :id="`claudex-feedback-panel-${activeTab}`"
          role="tabpanel"
          :aria-labelledby="`claudex-feedback-tab-${activeTab}`"
          class="p-6"
        >
          <DiagnosticsInbox v-if="activeTab === 'diagnostics'" />
          <FeedbackInbox v-else />
        </div>
      </div>
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
import DiagnosticsInbox from '@/components/admin/claudex/feedback/DiagnosticsInbox.vue'
import FeedbackInbox from '@/components/admin/claudex/feedback/FeedbackInbox.vue'
import {
  DIAGNOSTICS_RETENTION_MAX,
  FEEDBACK_RETENTION_MAX,
  PER_DAY_MAX,
  feedbackFormFromSettings,
  feedbackSettingsFromForm,
  validateFeedbackForm,
  type FeedbackSettingsForm
} from '@/components/admin/claudex/feedback/feedbackForm'
import { isMissingEndpoint, runWithStepUp, snapshot } from '@/components/admin/claudex/general/pageSupport'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Toggle from '@/components/common/Toggle.vue'
import Icon from '@/components/icons/Icon.vue'
import { getSettings, updateSettings, type FeedbackSettings } from '@/api/admin/claudex/feedback'
import { useStepUp } from '@/composables/useStepUp'

type InboxTab = 'diagnostics' | 'feedback'

const { t, te } = useI18n()
const stepUp = useStepUp()
const save = useClaudexSave('claudexFeedback')

const tabs: InboxTab[] = ['diagnostics', 'feedback']
const activeTab = ref<InboxTab>('diagnostics')
const loading = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const loaded = ref(false)
const form = ref<FeedbackSettingsForm>(feedbackFormFromSettings(null))
const savedSettings = ref<FeedbackSettings | null>(null)
const baseline = ref('')
const formError = ref<string | null>(null)

const problems = computed(() => validateFeedbackForm(form.value))
const dirty = computed(() => loaded.value && snapshot(feedbackSettingsFromForm(form.value)) !== baseline.value)
/** Whether the server currently accepts reports (the saved state, not the unsaved form). */
const collecting = computed(
  () => savedSettings.value?.diagnostics.enabled === true || savedSettings.value?.feedback.enabled === true
)

watch(
  form,
  () => {
    formError.value = null
    if (dirty.value) save.reset()
  },
  { deep: true }
)

function problemText(field: string): string {
  const problem = problems.value[field]
  return problem ? t(`admin.claudexFeedback.problems.${problem}`) : ''
}

function apply(settings: FeedbackSettings) {
  form.value = feedbackFormFromSettings(settings)
  const normalized = feedbackSettingsFromForm(form.value)
  savedSettings.value = normalized
  baseline.value = snapshot(normalized)
}

async function load() {
  loading.value = true
  loadError.value = null
  unavailable.value = false
  try {
    apply(await getSettings())
    loaded.value = true
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexFeedback', t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (Object.keys(problems.value).length > 0) {
    formError.value = t('admin.claudexFeedback.fixProblems')
    return
  }
  const body = feedbackSettingsFromForm(form.value)
  const result = await save.run(() => runWithStepUp(stepUp, () => updateSettings(body), t))
  if (result.ok) {
    apply(result.value)
  }
}

onMounted(load)
</script>
