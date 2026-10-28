<!--
  CLAUDEX: /admin/claudex/release (design 3.2 K4, server 2.2). The desktop
  release the Claudex app compares itself with: latest and minimum version,
  release notes (Markdown with a preview rendered like the app does), one
  download per platform and the gateway enforcement switch (off by default).
  Saving replaces the whole setting and goes through step-up.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexRelease.title')"
    :description="t('admin.claudexRelease.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-release-page"
    @retry="load"
  >
    <template v-if="updatedAt" #actions>
      <span class="text-xs text-gray-500 dark:text-gray-400" data-testid="claudex-release-updated">
        {{ t('admin.claudexRelease.updatedAt', { time: updatedAt }) }}
      </span>
    </template>

    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div class="card" data-testid="claudex-release-versions">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexRelease.versions.title') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexRelease.versions.description') }}
          </p>
        </div>
        <div class="grid gap-5 p-6 md:grid-cols-2">
          <div>
            <label for="claudex-release-latest" class="input-label mb-1.5 block">
              {{ t('admin.claudexRelease.versions.latest') }}
            </label>
            <input
              id="claudex-release-latest"
              v-model="form.latestVersion"
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="input w-full font-mono"
              :class="{ 'input-error': fieldProblem('latest_version') }"
              :maxlength="VERSION_MAX_LENGTH"
              placeholder="1.4.0"
              data-testid="claudex-release-latest"
            />
            <p v-if="fieldProblem('latest_version')" class="input-error-text mt-1.5" data-testid="claudex-release-latest-error">
              {{ problemText('latest_version') }}
            </p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexRelease.versions.latestHint') }}</p>
          </div>
          <div>
            <label for="claudex-release-minimum" class="input-label mb-1.5 block">
              {{ t('admin.claudexRelease.versions.minimum') }}
            </label>
            <input
              id="claudex-release-minimum"
              v-model="form.minimumVersion"
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="input w-full font-mono"
              :class="{ 'input-error': fieldProblem('minimum_version') }"
              :maxlength="VERSION_MAX_LENGTH"
              placeholder="1.2.0"
              data-testid="claudex-release-minimum"
            />
            <p v-if="fieldProblem('minimum_version')" class="input-error-text mt-1.5" data-testid="claudex-release-minimum-error">
              {{ problemText('minimum_version') }}
            </p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexRelease.versions.minimumHint') }}</p>
          </div>
          <div>
            <label for="claudex-release-published" class="input-label mb-1.5 block">
              {{ t('admin.claudexRelease.versions.publishedAt') }}
            </label>
            <input
              id="claudex-release-published"
              v-model="form.publishedAt"
              type="datetime-local"
              class="input w-full"
              :class="{ 'input-error': fieldProblem('published_at') }"
              data-testid="claudex-release-published"
            />
            <p v-if="fieldProblem('published_at')" class="input-error-text mt-1.5">{{ problemText('published_at') }}</p>
            <p v-else class="input-hint mt-1.5">{{ t('admin.claudexRelease.versions.publishedAtHint') }}</p>
          </div>
          <UrlInput
            v-model="form.releaseNotesUrl"
            :label="t('admin.claudexRelease.versions.notesUrl')"
            :hint="t('admin.claudexRelease.versions.notesUrlHint')"
            :show-error="showErrors"
            placeholder="https://"
            data-testid="claudex-release-notes-url"
          />
        </div>
      </div>

      <div class="card" data-testid="claudex-release-notes-card">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexRelease.notes.title') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexRelease.notes.description') }}
          </p>
        </div>
        <div class="p-6">
          <ReleaseNotesEditor v-model="form.releaseNotesMd" />
        </div>
      </div>

      <div class="card" data-testid="claudex-release-downloads">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexRelease.downloads.title') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexRelease.downloads.description') }}
          </p>
        </div>
        <div class="divide-y divide-gray-100 dark:divide-dark-700">
          <div
            v-for="platform in RELEASE_PLATFORMS"
            :key="platform"
            class="grid gap-4 px-6 py-4 lg:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]"
            :data-testid="`claudex-release-download-${platform}`"
          >
            <div class="pt-1">
              <p class="text-sm font-medium text-gray-900 dark:text-white">
                {{ platformLabel(platform) }}
              </p>
              <p class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ platform }}</p>
            </div>
            <UrlInput
              v-model="form.downloads[platform].url"
              :label="t('admin.claudexRelease.downloads.url')"
              :show-error="showErrors"
              :data-testid="`claudex-release-download-url-${platform}`"
            />
            <div>
              <label :for="`claudex-release-sha-${platform}`" class="input-label mb-1.5 block">
                {{ t('admin.claudexRelease.downloads.sha256') }}
              </label>
              <input
                :id="`claudex-release-sha-${platform}`"
                v-model="form.downloads[platform].sha256"
                type="text"
                autocomplete="off"
                spellcheck="false"
                maxlength="64"
                class="input w-full font-mono text-xs"
                :class="{ 'input-error': fieldProblem(`downloads.${platform}.sha256`) }"
                :placeholder="t('admin.claudexRelease.downloads.sha256Placeholder')"
                :data-testid="`claudex-release-download-sha-${platform}`"
              />
              <p v-if="fieldProblem(`downloads.${platform}.sha256`)" class="input-error-text mt-1.5">
                {{ problemText(`downloads.${platform}.sha256`) }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="card" data-testid="claudex-release-enforcement">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexRelease.enforcement.title') }}
          </h3>
        </div>
        <div class="space-y-4 p-6">
          <div class="flex items-start justify-between gap-6">
            <div class="min-w-0">
              <p id="claudex-release-enforce-label" class="font-medium text-gray-900 dark:text-white">
                {{ t('admin.claudexRelease.enforcement.label') }}
              </p>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('admin.claudexRelease.enforcement.hint') }}
              </p>
            </div>
            <Toggle
              v-model="form.enforceMinimumOnGateway"
              aria-labelledby="claudex-release-enforce-label"
              data-testid="claudex-release-enforce"
            />
          </div>
          <p
            class="rounded-lg border p-3 text-sm"
            :class="
              form.enforceMinimumOnGateway
                ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300'
                : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-dark-700 dark:bg-dark-900/40 dark:text-gray-400'
            "
            data-testid="claudex-release-enforce-warning"
          >
            {{ t('admin.claudexRelease.enforcement.warning') }}
          </p>
          <p
            v-if="form.enforceMinimumOnGateway && !form.minimumVersion.trim()"
            class="text-sm text-gray-500 dark:text-gray-400"
            data-testid="claudex-release-enforce-no-minimum"
          >
            {{ t('admin.claudexRelease.enforcement.noMinimum') }}
          </p>
        </div>
      </div>

      <SaveBar
        :saving="save.saving.value"
        :dirty="dirty"
        :saved="save.saved.value"
        :error="barError"
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
import UrlInput from '@/components/admin/claudex/common/UrlInput.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { isMissingEndpoint, runWithStepUp, snapshot } from '@/components/admin/claudex/general/pageSupport'
import ReleaseNotesEditor from '@/components/admin/claudex/release/ReleaseNotesEditor.vue'
import {
  RELEASE_NOTES_MAX_CHARS,
  VERSION_MAX_LENGTH,
  releaseFormFromSetting,
  releaseSettingFromForm,
  validateReleaseForm,
  emptyReleaseForm,
  type ReleaseForm
} from '@/components/admin/claudex/release/releaseForm'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Toggle from '@/components/common/Toggle.vue'
import {
  RELEASE_PLATFORMS,
  getRelease,
  updateRelease,
  type ClientReleaseResponse,
  type ReleasePlatform
} from '@/api/admin/claudex/release'
import { useStepUp } from '@/composables/useStepUp'
import { extractApiErrorMetadata } from '@/utils/apiError'
import { formatDateTime } from '@/utils/format'

const { t, te } = useI18n()
const stepUp = useStepUp()
const save = useClaudexSave('claudexRelease')

const loading = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const loaded = ref(false)
const form = ref<ReleaseForm>(emptyReleaseForm())
const baseline = ref('')
const updatedAtRaw = ref<string | null>(null)
const showErrors = ref(false)
const formError = ref<string | null>(null)

const payload = computed(() => releaseSettingFromForm(form.value))
const dirty = computed(() => loaded.value && snapshot(payload.value) !== baseline.value)
const problems = computed(() => validateReleaseForm(form.value))
const updatedAt = computed(() => (updatedAtRaw.value ? formatDateTime(updatedAtRaw.value) : ''))

/** The server names the offending field in metadata.field (CLAUDEX_RELEASE_INVALID). */
const serverField = computed(() => {
  const field = extractApiErrorMetadata(save.lastError.value)?.field
  return typeof field === 'string' ? field.replace(/^channels\.stable\./, '') : ''
})

const barError = computed(() => {
  if (formError.value) return formError.value
  if (!save.error.value) return null
  return serverField.value
    ? `${save.error.value} ${t('admin.claudexRelease.serverField', { field: serverField.value })}`
    : save.error.value
})

watch(
  form,
  () => {
    formError.value = null
    if (dirty.value) save.reset()
  },
  { deep: true }
)

function platformLabel(platform: ReleasePlatform): string {
  switch (platform) {
    case 'darwin-arm64':
      return t('admin.claudexRelease.platforms.macosArm64')
    case 'darwin-x64':
      return t('admin.claudexRelease.platforms.macosX64')
    case 'darwin-universal':
      return t('admin.claudexRelease.platforms.macosUniversal')
    case 'win32-x64':
      return t('admin.claudexRelease.platforms.windowsX64')
    case 'win32-arm64':
      return t('admin.claudexRelease.platforms.windowsArm64')
    case 'linux-x64':
      return t('admin.claudexRelease.platforms.linuxX64')
    case 'linux-arm64':
      return t('admin.claudexRelease.platforms.linuxArm64')
  }
  return platform
}

/** Text fields show their problem as soon as it exists; the server's field after a failed save. */
function fieldProblem(field: string): boolean {
  return Boolean(problems.value[field]) || (showErrors.value && serverField.value === field)
}

function problemText(field: string): string {
  const problem = problems.value[field]
  if (!problem) return t('admin.claudexRelease.problems.server')
  return t(`admin.claudexRelease.problems.${problem}`, { max: RELEASE_NOTES_MAX_CHARS })
}

function apply(setting: ClientReleaseResponse) {
  form.value = releaseFormFromSetting(setting)
  baseline.value = snapshot(releaseSettingFromForm(form.value))
  updatedAtRaw.value = setting.updated_at ?? null
}

async function load() {
  loading.value = true
  loadError.value = null
  unavailable.value = false
  try {
    apply(await getRelease())
    loaded.value = true
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexRelease', t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function submit() {
  showErrors.value = true
  if (Object.keys(problems.value).length > 0) {
    formError.value = t('admin.claudexRelease.fixProblems')
    return
  }
  formError.value = null
  const body = payload.value
  const result = await save.run(() => runWithStepUp(stepUp, () => updateRelease(body), t))
  if (result.ok) {
    apply(result.value)
    showErrors.value = false
  }
}

onMounted(load)
</script>
