<!--
  CLAUDEX: limits of the web app's runs (GET and PUT
  /admin/claudex/web/usage/settings, step-up): runs at once for everyone and
  for one user, the longest a run may last, and the informational price of a
  runner minute. A save carries the revision the form was loaded at.
-->
<template>
  <section class="card" data-testid="claudex-web-limits">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexWeb.limits.title') }}</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexWeb.limits.description') }}</p>
    </div>

    <div class="card-body space-y-5">
      <div v-if="loading" class="flex justify-center py-6" data-testid="claudex-web-limits-loading">
        <Icon name="refresh" size="lg" class="animate-spin text-gray-400" />
        <span class="sr-only">{{ t('admin.claudex.common.loading') }}</span>
      </div>

      <div
        v-else-if="loadError"
        role="alert"
        class="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300 sm:flex-row sm:items-center sm:justify-between"
        data-testid="claudex-web-limits-load-error"
      >
        <span>{{ t('admin.claudex.common.loadFailed') }}: {{ loadError }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('admin.claudex.common.retry') }}</button>
      </div>

      <template v-else-if="loaded">
        <div class="grid gap-5 md:grid-cols-2">
          <div v-for="field in fields" :key="field.key">
            <label :for="`claudex-web-limits-${field.testId}`" class="input-label mb-1.5 block">
              {{ t(`admin.claudexWeb.limits.${field.key}`) }}
            </label>
            <input
              :id="`claudex-web-limits-${field.testId}`"
              v-model.number="form[field.key]"
              type="number"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              class="input w-full"
              :class="{ 'input-error': show(field.key) }"
              :data-testid="`claudex-web-limits-${field.testId}`"
            />
            <p v-if="show(field.key)" class="input-error-text mt-1.5">{{ problemText(field.key) }}</p>
            <p v-else class="input-hint mt-1.5">{{ t(`admin.claudexWeb.limits.${field.key}Hint`) }}</p>
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
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { runWithStepUp, snapshot } from '@/components/admin/claudex/general/pageSupport'
import Icon from '@/components/icons/Icon.vue'
import { getWebUsageSettings, updateWebUsageSettings, type WebUsageSettings } from '@/api/admin/claudex/web'
import type { StepUpController } from '@/composables/useStepUp'
import {
  MAX_CONCURRENT_LIMIT,
  MAX_CONCURRENT_PER_USER_LIMIT,
  MAX_MINUTE_PRICE_USD,
  MAX_SESSION_MINUTES_LIMIT,
  limitsFromSettings,
  limitsProblems,
  limitsUpdateFromForm,
  type WebLimitsForm
} from './webForm'

const props = defineProps<{ stepUp: StepUpController }>()

const { t, te } = useI18n()
const save = useClaudexSave('claudexWeb')

const fields: Array<{ key: keyof WebLimitsForm; testId: string; min: number; max: number; step: number }> = [
  { key: 'maxConcurrent', testId: 'concurrent', min: 1, max: MAX_CONCURRENT_LIMIT, step: 1 },
  { key: 'maxConcurrentPerUser', testId: 'per-user', min: 1, max: MAX_CONCURRENT_PER_USER_LIMIT, step: 1 },
  { key: 'maxSessionMinutes', testId: 'minutes', min: 1, max: MAX_SESSION_MINUTES_LIMIT, step: 1 },
  { key: 'minutePriceUsd', testId: 'price', min: 0, max: MAX_MINUTE_PRICE_USD, step: 0.0001 }
]

const loading = ref(false)
const loadError = ref<string | null>(null)
const loaded = ref(false)
const revision = ref(0)
const form = ref<WebLimitsForm>(limitsFromSettings(null))
const baseline = ref('')
const formError = ref<string | null>(null)

const problems = computed(() => limitsProblems(form.value))
const current = computed(() => snapshot(limitsUpdateFromForm(form.value, 0)))
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
  return t(`admin.claudexWeb.problems.${problems.value[field]}`)
}

function apply(setting: WebUsageSettings) {
  revision.value = setting.revision
  form.value = limitsFromSettings(setting)
  baseline.value = snapshot(limitsUpdateFromForm(form.value, 0))
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    apply(await getWebUsageSettings())
    loaded.value = true
  } catch (err) {
    loadError.value = claudexErrorMessage(err, t, te, 'claudexWeb', t('admin.claudex.common.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (Object.keys(problems.value).length > 0) {
    formError.value = t('admin.claudexWeb.fixProblems')
    return
  }
  const body = limitsUpdateFromForm(form.value, revision.value)
  const result = await save.run(() => runWithStepUp(props.stepUp, () => updateWebUsageSettings(body), t))
  if (result.ok) {
    apply(result.value)
  } else if (save.reason.value === 'CLAUDEX_WEB_USAGE_SETTINGS_CONFLICT') {
    const message = save.error.value
    await load()
    await nextTick()
    formError.value = message
  }
}

onMounted(load)
</script>
