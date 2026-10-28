<!--
  CLAUDEX: who may use the Claudex web app and how many sessions one user may
  have (GET and PUT /admin/claudex/web/settings, step-up). Off, administrators
  (and the users on the list), or everyone. A save carries the revision the
  form was loaded at; when another administrator saved first the page says so
  and reloads.
-->
<template>
  <section class="card" data-testid="claudex-web-access">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexWeb.access.title') }}</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexWeb.access.description') }}</p>
    </div>

    <div class="card-body space-y-5">
      <div v-if="loading" class="flex justify-center py-6" data-testid="claudex-web-access-loading">
        <Icon name="refresh" size="lg" class="animate-spin text-gray-400" />
        <span class="sr-only">{{ t('admin.claudex.common.loading') }}</span>
      </div>

      <div
        v-else-if="loadError"
        role="alert"
        class="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300 sm:flex-row sm:items-center sm:justify-between"
        data-testid="claudex-web-access-load-error"
      >
        <span>{{ t('admin.claudex.common.loadFailed') }}: {{ loadError }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('admin.claudex.common.retry') }}</button>
      </div>

      <template v-else-if="loaded">
        <div class="grid gap-5 md:grid-cols-2">
          <div>
            <label for="claudex-web-access-mode" class="input-label mb-1.5 block">
              {{ t('admin.claudexWeb.access.mode') }}
            </label>
            <select
              id="claudex-web-access-mode"
              v-model="form.access"
              class="input w-full"
              data-testid="claudex-web-access-mode"
            >
              <option value="off">{{ t('admin.claudexWeb.access.off') }}</option>
              <option value="allowlist">{{ t('admin.claudexWeb.access.allowlist') }}</option>
              <option value="everyone">{{ t('admin.claudexWeb.access.everyone') }}</option>
            </select>
            <p class="input-hint mt-1.5" data-testid="claudex-web-access-mode-hint">
              {{ t(`admin.claudexWeb.access.${form.access}Hint`) }}
            </p>
          </div>
          <div>
            <label for="claudex-web-access-sessions" class="input-label mb-1.5 block">
              {{ t('admin.claudexWeb.access.maxSessions') }}
            </label>
            <input
              id="claudex-web-access-sessions"
              v-model.number="form.maxSessionsPerUser"
              type="number"
              min="1"
              :max="MAX_SESSIONS_PER_USER_LIMIT"
              step="1"
              class="input w-full"
              :class="{ 'input-error': show('maxSessionsPerUser') }"
              data-testid="claudex-web-access-sessions"
            />
            <p v-if="show('maxSessionsPerUser')" class="input-error-text mt-1.5">
              {{ problemText('maxSessionsPerUser') }}
            </p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexWeb.access.maxSessionsHint') }}</p>
          </div>
        </div>

        <div v-if="form.access === 'allowlist'" class="grid gap-5 md:grid-cols-2" data-testid="claudex-web-access-lists">
          <TagInput
            v-model="form.emails"
            :label="t('admin.claudexWeb.access.emails')"
            :placeholder="t('admin.claudexWeb.access.emailsPlaceholder')"
            :hint="t('admin.claudexWeb.access.emailsHint')"
            :max="MAX_ALLOWLIST"
            case-insensitive
            :validate="validateEmail"
            id="claudex-web-access-emails"
          />
          <TagInput
            v-model="form.userIds"
            :label="t('admin.claudexWeb.access.userIds')"
            :placeholder="t('admin.claudexWeb.access.userIdsPlaceholder')"
            :hint="t('admin.claudexWeb.access.userIdsHint')"
            :max="MAX_ALLOWLIST"
            :validate="validateUserId"
            id="claudex-web-access-user-ids"
          />
        </div>

        <p
          v-if="form.access === 'off' && wasOn"
          role="note"
          class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
          data-testid="claudex-web-access-off-note"
        >
          {{ t('admin.claudexWeb.access.offNote') }}
        </p>

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
import TagInput from '@/components/admin/claudex/common/TagInput.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { runWithStepUp, snapshot } from '@/components/admin/claudex/general/pageSupport'
import Icon from '@/components/icons/Icon.vue'
import { getWebSettings, updateWebSettings, type WebSettings } from '@/api/admin/claudex/web'
import type { StepUpController } from '@/composables/useStepUp'
import {
  MAX_ALLOWLIST,
  MAX_SESSIONS_PER_USER_LIMIT,
  accessFromSettings,
  accessProblems,
  accessUpdateFromForm,
  validateEmail,
  validateUserId,
  type WebAccessForm
} from './webForm'

const props = defineProps<{ stepUp: StepUpController }>()

const { t, te } = useI18n()
const save = useClaudexSave('claudexWeb')

const loading = ref(false)
const loadError = ref<string | null>(null)
const loaded = ref(false)
const revision = ref(0)
const form = ref<WebAccessForm>(accessFromSettings(null))
const baseline = ref('')
const wasOn = ref(false)
const formError = ref<string | null>(null)

const problems = computed(() => accessProblems(form.value))
const current = computed(() => snapshot(accessUpdateFromForm(form.value, 0)))
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

function apply(setting: WebSettings) {
  revision.value = setting.revision
  form.value = accessFromSettings(setting)
  baseline.value = snapshot(accessUpdateFromForm(form.value, 0))
  wasOn.value = setting.enabled
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    apply(await getWebSettings())
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
  const body = accessUpdateFromForm(form.value, revision.value)
  const result = await save.run(() => runWithStepUp(props.stepUp, () => updateWebSettings(body), t))
  if (result.ok) {
    apply(result.value)
  } else if (save.reason.value === 'CLAUDEX_WEB_SETTINGS_CONFLICT') {
    // Someone else saved first: show what is stored now, keep the error text.
    const message = save.error.value
    await load()
    await nextTick()
    formError.value = message
  }
}

onMounted(load)
</script>
