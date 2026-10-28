<!--
  CLAUDEX: the Sign-in card of /admin/claudex/general (package LOGIN): "sign
  in with an email code" (needs SMTP and Backend mode off) and the privacy
  policy link of the sign-in page. Saved with step-up through the page's
  controller. Hidden when the server has no /admin/claudex/sign-in.
-->
<template>
  <div v-if="!missing" class="card" data-testid="claudex-general-sign-in">
    <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexGeneral.signIn.title') }}
      </h3>
    </div>
    <div v-if="loadError" class="p-6" data-testid="claudex-general-sign-in-load-error">
      <p class="text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>
      <button type="button" class="btn btn-secondary mt-3" @click="load">
        {{ t('admin.claudexGeneral.signIn.retry') }}
      </button>
    </div>
    <div v-else-if="saved" class="space-y-4 p-6">
      <div class="flex items-start justify-between gap-6">
        <div class="min-w-0">
          <p id="claudex-general-email-code-label" class="font-medium text-gray-900 dark:text-white">
            {{ t('admin.claudexGeneral.signIn.emailCode') }}
          </p>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexGeneral.signIn.emailCodeHint') }}
          </p>
        </div>
        <Toggle
          v-model="form.emailCode"
          aria-labelledby="claudex-general-email-code-label"
          data-testid="claudex-general-email-code"
        />
      </div>
      <p
        v-if="form.emailCode && !saved.smtp_configured"
        class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
        data-testid="claudex-general-email-code-smtp"
      >
        {{ t('admin.claudexGeneral.signIn.smtpMissing') }}
      </p>
      <p
        v-else-if="form.emailCode && saved.backend_mode_enabled"
        class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
        data-testid="claudex-general-email-code-backend-mode"
      >
        {{ t('admin.claudexGeneral.signIn.backendMode') }}
      </p>
      <p v-else class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-general-email-code-smtp-note">
        {{ t('admin.claudexGeneral.signIn.smtpNote') }}
      </p>
      <p class="text-sm text-gray-700 dark:text-gray-300" data-testid="claudex-general-email-code-status">
        {{
          saved.email_code_login_available
            ? t('admin.claudexGeneral.signIn.available')
            : t('admin.claudexGeneral.signIn.unavailable')
        }}
      </p>

      <div>
        <label for="claudex-general-privacy-url" class="input-label">
          {{ t('admin.claudexGeneral.signIn.privacyPolicyUrl') }}
        </label>
        <input
          id="claudex-general-privacy-url"
          v-model="form.privacyPolicyUrl"
          type="text"
          class="input"
          maxlength="2000"
          :placeholder="t('admin.claudexGeneral.signIn.privacyPolicyPlaceholder')"
          :aria-invalid="!urlValid"
          data-testid="claudex-general-privacy-url"
        />
        <p
          v-if="!urlValid"
          class="mt-1 text-sm text-red-600 dark:text-red-400"
          data-testid="claudex-general-privacy-url-error"
        >
          {{ t('admin.claudexGeneral.signIn.privacyPolicyInvalid') }}
        </p>
        <p v-else class="input-hint">{{ t('admin.claudexGeneral.signIn.privacyPolicyHint') }}</p>
      </div>

      <SaveBar
        :saving="save.saving.value"
        :dirty="dirty"
        :saved="save.saved.value"
        :error="save.error.value"
        :disabled="!dirty || !urlValid"
        @save="submit"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { isMissingEndpoint, runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import Toggle from '@/components/common/Toggle.vue'
import { getSignIn, updateSignIn, validPrivacyPolicyURL, type SignInSetting } from '@/api/admin/claudex/signIn'
import type { StepUpController } from '@/composables/useStepUp'

const props = defineProps<{ stepUp: StepUpController }>()

const { t, te } = useI18n()
const save = useClaudexSave('claudexGeneral')

const missing = ref(false)
const loadError = ref<string | null>(null)
const saved = ref<SignInSetting | null>(null)
const form = reactive({ emailCode: false, privacyPolicyUrl: '' })

const urlValid = computed(() => validPrivacyPolicyURL(form.privacyPolicyUrl))
const dirty = computed(
  () =>
    saved.value !== null &&
    (form.emailCode !== saved.value.email_code_login_enabled ||
      form.privacyPolicyUrl.trim() !== saved.value.privacy_policy_url)
)

watch(
  () => [form.emailCode, form.privacyPolicyUrl],
  () => {
    if (dirty.value) save.reset()
  }
)

function apply(setting: SignInSetting) {
  saved.value = {
    email_code_login_enabled: setting.email_code_login_enabled === true,
    privacy_policy_url: setting.privacy_policy_url ?? '',
    smtp_configured: setting.smtp_configured === true,
    backend_mode_enabled: setting.backend_mode_enabled === true,
    email_code_login_available: setting.email_code_login_available === true
  }
  form.emailCode = saved.value.email_code_login_enabled
  form.privacyPolicyUrl = saved.value.privacy_policy_url
}

async function load() {
  loadError.value = null
  try {
    apply(await getSignIn())
  } catch (err) {
    if (isMissingEndpoint(err)) {
      missing.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexGeneral', t('admin.claudex.common.loadFailed'))
    }
  }
}

async function submit() {
  if (!urlValid.value) return
  const body = { email_code_login_enabled: form.emailCode, privacy_policy_url: form.privacyPolicyUrl.trim() }
  const result = await save.run(() => runWithStepUp(props.stepUp, () => updateSignIn(body), t))
  if (result.ok) apply(result.value)
}

onMounted(load)
</script>
