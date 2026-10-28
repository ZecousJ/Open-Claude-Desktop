<!--
  CLAUDEX: /admin/claudex/github. The GitHub OAuth App or GitHub App that lets
  users of Claudex on the web connect their GitHub account and pick a
  repository for Code. The client secret is write-only (shown masked). Until
  this is turned on the web app says GitHub isn't set up on this service.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexGitHub.title')"
    :description="t('admin.claudexGitHub.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-github-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div v-if="warnings.length" class="space-y-2" data-testid="claudex-github-warnings">
        <div
          v-for="(warning, index) in warnings"
          :key="index"
          role="status"
          class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
          data-testid="claudex-github-warning"
        >
          <Icon name="exclamationTriangle" size="sm" class="mt-0.5 flex-shrink-0" />
          <span>{{ warning }}</span>
        </div>
      </div>

      <div class="card" data-testid="claudex-github-app">
        <div class="flex items-start justify-between gap-6 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <div class="min-w-0">
            <h3 id="claudex-github-app-title" class="text-base font-semibold text-gray-900 dark:text-white">
              {{ t('admin.claudexGitHub.app.title') }}
            </h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexGitHub.app.description') }}</p>
          </div>
          <Toggle v-model="form.enabled" aria-labelledby="claudex-github-app-title" data-testid="claudex-github-enabled" />
        </div>

        <div class="space-y-5 p-6">
          <div>
            <label for="claudex-github-kind" class="input-label mb-1.5 block">{{ t('admin.claudexGitHub.kind') }}</label>
            <select id="claudex-github-kind" v-model="form.kind" class="input w-full" data-testid="claudex-github-kind">
              <option value="oauth_app">{{ t('admin.claudexGitHub.kinds.oauth_app') }}</option>
              <option value="github_app">{{ t('admin.claudexGitHub.kinds.github_app') }}</option>
            </select>
            <p class="input-hint mt-1.5">{{ t('admin.claudexGitHub.kindHint') }}</p>
          </div>

          <div>
            <label for="claudex-github-base-url" class="input-label mb-1.5 block">
              {{ t('admin.claudexGitHub.publicBaseUrl') }}
            </label>
            <input
              id="claudex-github-base-url"
              v-model="form.publicBaseUrl"
              type="url"
              autocomplete="off"
              spellcheck="false"
              class="input w-full font-mono text-sm"
              :class="{ 'input-error': show('public_base_url') }"
              data-testid="claudex-github-base-url"
            />
            <p v-if="show('public_base_url')" class="input-error-text mt-1.5">{{ problemText('public_base_url') }}</p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexGitHub.publicBaseUrlHint') }}</p>
            <p v-if="callbackUrl" class="mt-2 text-sm text-gray-600 dark:text-gray-300" data-testid="claudex-github-callback">
              {{ t('admin.claudexGitHub.callbackUrl') }}
              <code class="ml-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-dark-700">{{ callbackUrl }}</code>
            </p>
          </div>

          <div>
            <label for="claudex-github-client-id" class="input-label mb-1.5 block">
              {{ t('admin.claudexGitHub.clientId') }}
            </label>
            <input
              id="claudex-github-client-id"
              v-model="form.clientId"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :maxlength="CLIENT_ID_MAX_LENGTH"
              class="input w-full font-mono text-sm"
              :class="{ 'input-error': show('client_id') }"
              data-testid="claudex-github-client-id"
            />
            <p v-if="show('client_id')" class="input-error-text mt-1.5">{{ problemText('client_id') }}</p>
          </div>

          <div data-testid="claudex-github-secret">
            <label for="claudex-github-client-secret" class="input-label mb-1.5 block">
              {{ t('admin.claudexGitHub.clientSecret') }}
            </label>
            <div class="mb-2 flex flex-wrap items-center gap-2 text-sm" data-testid="claudex-github-secret-status">
              <template v-if="form.clearSecret">
                <span class="text-amber-700 dark:text-amber-300">{{ t('admin.claudexGitHub.secretWillBeRemoved') }}</span>
                <button type="button" class="btn btn-ghost btn-sm" data-testid="claudex-github-secret-undo" @click="undoRemoveSecret">
                  {{ t('admin.claudexGitHub.undoRemoveSecret') }}
                </button>
              </template>
              <template v-else-if="form.secretConfigured">
                <span class="text-gray-600 dark:text-gray-300">{{ t('admin.claudexGitHub.secretStored') }}</span>
                <code
                  v-if="form.secretMasked"
                  class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-dark-700 dark:text-gray-300"
                  data-testid="claudex-github-secret-masked"
                  >{{ form.secretMasked }}</code
                >
                <button
                  type="button"
                  class="btn btn-ghost btn-sm text-red-600 dark:text-red-400"
                  data-testid="claudex-github-secret-remove"
                  @click="removeSecret"
                >
                  {{ t('admin.claudexGitHub.removeSecret') }}
                </button>
              </template>
              <span v-else class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexGitHub.secretNotStored') }}</span>
            </div>
            <input
              id="claudex-github-client-secret"
              v-model="form.clientSecret"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              :maxlength="CLIENT_SECRET_MAX_LENGTH"
              class="input w-full font-mono text-sm"
              :class="{ 'input-error': show('client_secret') }"
              :disabled="!canStoreSecret"
              :placeholder="
                form.secretConfigured && !form.clearSecret
                  ? t('admin.claudexGitHub.secretReplacePlaceholder')
                  : t('admin.claudexGitHub.secretPlaceholder')
              "
              data-testid="claudex-github-client-secret"
            />
            <p v-if="show('client_secret')" class="input-error-text mt-1.5">{{ problemText('client_secret') }}</p>
            <p v-else-if="!canStoreSecret" class="input-hint mt-1.5">{{ t('admin.claudexGitHub.cannotStoreSecret') }}</p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexGitHub.secretHint') }}</p>
          </div>
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
import {
  CLIENT_ID_MAX_LENGTH,
  CLIENT_SECRET_MAX_LENGTH,
  githubFormFromSetting,
  githubUpdateFromForm,
  validateGitHubForm,
  type GitHubForm
} from '@/components/admin/claudex/github/githubForm'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Toggle from '@/components/common/Toggle.vue'
import Icon from '@/components/icons/Icon.vue'
import { getGitHub, updateGitHub, type GitHubSettingResponse } from '@/api/admin/claudex/github'
import { useStepUp } from '@/composables/useStepUp'

const { t, te } = useI18n()
const stepUp = useStepUp()
const save = useClaudexSave('claudexGitHub')

const loading = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const loaded = ref(false)
const form = ref<GitHubForm>(githubFormFromSetting(null))
const baseline = ref('')
const warnings = ref<string[]>([])
const callbackUrl = ref('')
const canStoreSecret = ref(true)
const formError = ref<string | null>(null)

const problems = computed(() => validateGitHubForm(form.value))
const current = computed(() => snapshot(githubUpdateFromForm(form.value)))
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
  return problem ? t(`admin.claudexGitHub.problems.${problem}`) : ''
}

// The switch position before Remove secret, so Undo puts it back.
let enabledBeforeRemove = false

/** Removing the stored secret turns GitHub off (the server does the same). */
function removeSecret() {
  enabledBeforeRemove = form.value.enabled
  form.value.clearSecret = true
  form.value.clientSecret = ''
  form.value.enabled = false
}

function undoRemoveSecret() {
  form.value.clearSecret = false
  form.value.enabled = enabledBeforeRemove
}

function apply(setting: GitHubSettingResponse) {
  form.value = githubFormFromSetting(setting)
  baseline.value = snapshot(githubUpdateFromForm(form.value))
  warnings.value = Array.isArray(setting.warnings) ? setting.warnings.filter((w) => typeof w === 'string' && w) : []
  callbackUrl.value = typeof setting.callback_url === 'string' ? setting.callback_url : ''
  canStoreSecret.value = setting.can_store_secret !== false
}

async function load() {
  loading.value = true
  loadError.value = null
  unavailable.value = false
  try {
    apply(await getGitHub())
    loaded.value = true
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexGitHub', t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (Object.keys(problems.value).length > 0) {
    formError.value = t('admin.claudexGitHub.fixProblems')
    return
  }
  const body = githubUpdateFromForm(form.value)
  const result = await save.run(() => runWithStepUp(stepUp, () => updateGitHub(body), t))
  if (result.ok) {
    apply(result.value)
  }
}

onMounted(load)
</script>
