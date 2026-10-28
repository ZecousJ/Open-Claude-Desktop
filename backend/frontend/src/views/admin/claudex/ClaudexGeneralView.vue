<!--
  CLAUDEX: /admin/claudex/general (design 3.2 K4). Whether the web console is
  for administrators only (web_console_admin_only, saved with step-up), the
  sign-in options (LOGIN: email code sign-in, privacy policy link), the
  upstream Backend mode status (read-only here, with its effect on the Claudex
  desktop app) and the disabled online update.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexGeneral.title')"
    :description="t('admin.claudexGeneral.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-general-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div class="card" data-testid="claudex-general-web-console">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexGeneral.webConsole.title') }}
          </h3>
        </div>
        <div class="space-y-4 p-6">
          <div class="flex items-start justify-between gap-6">
            <div class="min-w-0">
              <p id="claudex-general-admin-only-label" class="font-medium text-gray-900 dark:text-white">
                {{ t('admin.claudexGeneral.webConsole.adminOnly') }}
              </p>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('admin.claudexGeneral.webConsole.adminOnlyHint') }}
              </p>
            </div>
            <Toggle
              v-model="form.adminOnly"
              aria-labelledby="claudex-general-admin-only-label"
              data-testid="claudex-general-admin-only"
            />
          </div>
          <p
            v-if="!form.adminOnly"
            class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
            data-testid="claudex-general-open-note"
          >
            {{ t('admin.claudexGeneral.webConsole.openNote') }}
          </p>
          <SaveBar
            :saving="save.saving.value"
            :dirty="dirty"
            :saved="save.saved.value"
            :error="save.error.value"
            :disabled="!dirty"
            @save="submit"
          />
        </div>
      </div>

      <SignInSettingsCard :step-up="stepUp" />

      <div class="card" data-testid="claudex-general-backend-mode">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexGeneral.backendMode.title') }}
          </h3>
        </div>
        <div class="space-y-4 p-6">
          <div class="flex items-center justify-between gap-6">
            <p class="text-sm text-gray-700 dark:text-gray-300">
              {{ t('admin.claudexGeneral.backendMode.status') }}
            </p>
            <span
              class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
              :class="
                backendModeEnabled
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-gray-100 text-gray-700 dark:bg-dark-700 dark:text-gray-300'
              "
              data-testid="claudex-general-backend-mode-status"
            >
              {{ backendModeEnabled ? t('admin.claudexGeneral.backendMode.on') : t('admin.claudexGeneral.backendMode.off') }}
            </span>
          </div>
          <div
            v-if="backendModeEnabled"
            role="alert"
            class="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800/50 dark:bg-red-900/20"
            data-testid="claudex-general-backend-mode-warning"
          >
            <p class="text-sm font-medium text-red-700 dark:text-red-300">
              {{ t('admin.claudexGeneral.backendMode.warningTitle') }}
            </p>
            <p class="mt-1 text-sm text-red-600 dark:text-red-400">
              {{ t('admin.claudexGeneral.backendMode.warning') }}
            </p>
          </div>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexGeneral.backendMode.offHint') }}
          </p>
          <router-link
            to="/admin/settings"
            class="inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:underline dark:text-primary-400"
            data-testid="claudex-general-settings-link"
          >
            {{ t('admin.claudexGeneral.backendMode.openSettings') }}
            <Icon name="arrowRight" size="sm" />
          </router-link>
        </div>
      </div>

      <div class="card" data-testid="claudex-general-online-update">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexGeneral.onlineUpdate.title') }}
          </h3>
        </div>
        <div class="p-6">
          <p class="text-sm text-gray-700 dark:text-gray-300">
            {{ t('admin.claudexGeneral.onlineUpdate.disabled') }}
          </p>
        </div>
      </div>
    </template>

    <TotpStepUpDialog :controller="stepUp" />
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ClaudexUnavailable from '@/components/admin/claudex/common/ClaudexUnavailable.vue'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { isMissingEndpoint, runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import SignInSettingsCard from '@/components/admin/claudex/general/SignInSettingsCard.vue'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Toggle from '@/components/common/Toggle.vue'
import Icon from '@/components/icons/Icon.vue'
import { getWebConsole, updateWebConsole, type WebConsoleSetting } from '@/api/admin/claudex/general'
import { useStepUp } from '@/composables/useStepUp'
import { useWebConsoleStore } from '@/stores/webConsole'

const { t, te } = useI18n()
const stepUp = useStepUp()
const save = useClaudexSave('claudexGeneral')
const webConsole = useWebConsoleStore()

const loading = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const loaded = ref(false)
const saved = ref<WebConsoleSetting | null>(null)
const form = reactive({ adminOnly: true })

const backendModeEnabled = computed(() => saved.value?.backend_mode_enabled === true)
const dirty = computed(() => saved.value !== null && form.adminOnly !== saved.value.admin_only)

watch(
  () => form.adminOnly,
  () => {
    if (dirty.value) save.reset()
  }
)

function apply(setting: WebConsoleSetting) {
  saved.value = { admin_only: setting.admin_only !== false, backend_mode_enabled: setting.backend_mode_enabled === true }
  form.adminOnly = saved.value.admin_only
}

async function load() {
  loading.value = true
  loadError.value = null
  unavailable.value = false
  try {
    apply(await getWebConsole())
    loaded.value = true
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexGeneral', t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function submit() {
  const adminOnly = form.adminOnly
  const result = await save.run(() => runWithStepUp(stepUp, () => updateWebConsole({ admin_only: adminOnly }), t))
  if (result.ok) {
    apply(result.value)
    // The route guard of this tab follows the new value without a reload.
    webConsole.setAdminOnly(result.value.admin_only !== false)
  }
}

onMounted(load)
</script>
