<!--
  CLAUDEX: the provisioning card of /admin/claudex/devices (setting
  claudex_provisioning, B4). Saving asks for confirmation, then goes through
  step-up (PUT /admin/claudex/provisioning).
-->
<template>
  <section class="card" data-testid="claudex-provisioning-card">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexDevices.provisioning.title') }}
      </h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexDevices.provisioning.description') }}
      </p>
    </div>

    <div class="card-body space-y-6">
      <!-- Enabled -->
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm font-medium text-gray-900 dark:text-white">
            {{ t('admin.claudexDevices.provisioning.enabled') }}
          </p>
          <p class="input-hint mt-1">{{ t('admin.claudexDevices.provisioning.enabledHint') }}</p>
        </div>
        <Toggle v-model="form.enabled" data-testid="claudex-provisioning-enabled" />
      </div>

      <!-- Strategy -->
      <fieldset>
        <legend class="input-label">{{ t('admin.claudexDevices.provisioning.strategy') }}</legend>
        <div class="mt-2 space-y-2">
          <label
            v-for="option in strategyOptions"
            :key="option.value"
            class="flex cursor-pointer items-start gap-2 text-sm"
          >
            <input
              v-model="form.strategy"
              type="radio"
              name="claudex-provisioning-strategy"
              class="mt-0.5 h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500"
              :value="option.value"
              :data-testid="`claudex-strategy-${option.value}`"
            />
            <span>
              <span class="font-medium text-gray-900 dark:text-white">{{ option.label }}</span>
              <span class="block text-xs text-gray-500 dark:text-gray-400">{{ option.hint }}</span>
            </span>
          </label>
        </div>
      </fieldset>

      <!-- Default group -->
      <div>
        <label for="claudex-default-group" class="input-label">{{
          t('admin.claudexDevices.provisioning.defaultGroup')
        }}</label>
        <select
          id="claudex-default-group"
          v-model="form.defaultGroupId"
          class="input mt-1.5 w-full sm:max-w-md"
          :class="{ 'input-error': shownErrors.defaultGroup }"
          data-testid="claudex-default-group"
        >
          <option :value="null">{{ t('admin.claudexDevices.provisioning.noDefaultGroup') }}</option>
          <option v-for="group in defaultGroupOptions" :key="group.id" :value="group.id">
            {{ group.label }}
          </option>
        </select>
        <p v-if="shownErrors.defaultGroup" class="input-error-text mt-1.5">{{ t(shownErrors.defaultGroup) }}</p>
        <p v-else class="input-hint mt-1.5">
          {{
            form.strategy === 'fixed'
              ? t('admin.claudexDevices.provisioning.defaultGroupHintFixed')
              : t('admin.claudexDevices.provisioning.defaultGroupHint')
          }}
        </p>
      </div>

      <!-- Allowed groups -->
      <GroupMultiSelect
        v-model="form.allowedGroupIds"
        :groups="groups"
        :label="t('admin.claudexDevices.provisioning.allowedGroups')"
        :hint="t('admin.claudexDevices.provisioning.allowedGroupsHint')"
      />

      <!-- Grant at sign-up -->
      <div>
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-white">
              {{ t('admin.claudexDevices.provisioning.grantDefaultGroup') }}
            </p>
            <p class="input-hint mt-1">{{ t('admin.claudexDevices.provisioning.grantDefaultGroupHint') }}</p>
          </div>
          <Toggle v-model="form.grantDefaultGroup" data-testid="claudex-grant-default-group" />
        </div>
        <div
          v-if="form.grantDefaultGroup"
          role="alert"
          class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
          data-testid="claudex-grant-warning"
        >
          <p class="font-medium">{{ t('admin.claudexDevices.provisioning.grantWarning') }}</p>
          <p v-if="shownErrors.grantDefaultGroup" class="mt-1">{{ t(shownErrors.grantDefaultGroup) }}</p>
          <p v-else-if="defaultGroup && !grantsAtSignup(defaultGroup)" class="mt-1" data-testid="claudex-grant-no-effect">
            {{ t('admin.claudexDevices.provisioning.grantNoEffect', { group: defaultGroup.name }) }}
          </p>
        </div>
      </div>

      <!-- Key defaults -->
      <fieldset>
        <legend class="input-label">{{ t('admin.claudexDevices.provisioning.keyDefaults') }}</legend>
        <p class="input-hint mt-1">{{ t('admin.claudexDevices.provisioning.keyDefaultsHint') }}</p>
        <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div v-for="field in keyFields" :key="field.key">
            <label :for="`claudex-kd-${field.key}`" class="input-label text-xs">{{ field.label }}</label>
            <input
              :id="`claudex-kd-${field.key}`"
              v-model="form[field.key]"
              type="number"
              :min="field.min"
              :step="field.step"
              class="input mt-1 w-full"
              :class="{ 'input-error': shownErrors[field.key] }"
              :placeholder="field.placeholder"
              :data-testid="`claudex-kd-${field.key}`"
            />
            <p v-if="shownErrors[field.key]" class="input-error-text mt-1">{{ t(shownErrors[field.key]!) }}</p>
          </div>
        </div>
      </fieldset>

      <!-- Max devices per user -->
      <div>
        <label for="claudex-max-devices" class="input-label">{{
          t('admin.claudexDevices.provisioning.maxDevices')
        }}</label>
        <input
          id="claudex-max-devices"
          v-model="form.maxDevicesPerUser"
          type="number"
          :min="MAX_DEVICES_MIN"
          :max="MAX_DEVICES_MAX"
          step="1"
          class="input mt-1.5 w-32"
          :class="{ 'input-error': shownErrors.maxDevicesPerUser }"
          data-testid="claudex-max-devices"
        />
        <p v-if="shownErrors.maxDevicesPerUser" class="input-error-text mt-1.5">
          {{ t(shownErrors.maxDevicesPerUser) }}
        </p>
        <p v-else class="input-hint mt-1.5">{{ t('admin.claudexDevices.provisioning.maxDevicesHint') }}</p>
      </div>

      <!-- User API keys (owner decision 17) -->
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm font-medium text-gray-900 dark:text-white">
            {{ t('admin.claudexDevices.provisioning.userApiKeys') }}
          </p>
          <p class="input-hint mt-1">{{ t('admin.claudexDevices.provisioning.userApiKeysHint') }}</p>
        </div>
        <Toggle v-model="form.userApiKeysEnabled" data-testid="claudex-user-api-keys" />
      </div>

      <!-- Fixed note (owner decision 13; not a setting) -->
      <div
        class="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-300"
        data-testid="claudex-revoke-all-note"
      >
        <Icon name="infoCircle" size="sm" class="mt-0.5 flex-shrink-0 text-gray-400" />
        <span>{{ t('admin.claudexDevices.provisioning.revokeAllNote') }}</span>
      </div>

      <SaveBar
        :saving="save.saving.value"
        :dirty="dirty"
        :saved="save.saved.value && !dirty"
        :error="save.error.value"
        :disabled="!dirty"
        @save="submit"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import Toggle from '@/components/common/Toggle.vue'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import type { StepUpController } from '@/composables/useStepUp'
import { updateProvisioning, type ProvisioningSettings } from '@/api/admin/claudex/devices'
import type { AdminGroup } from '@/types'
import GroupMultiSelect from './GroupMultiSelect.vue'
import type { ConfirmController } from './useConfirm'
import {
  MAX_DEVICES_MAX,
  MAX_DEVICES_MIN,
  formToSettings,
  grantsAtSignup,
  normalizeProvisioning,
  provisioningChanges,
  settingsToForm,
  validateProvisioning,
  type ProvisioningErrors,
  type ProvisioningForm
} from './provisioning'

const props = defineProps<{
  settings: ProvisioningSettings
  groups: AdminGroup[]
  stepUp: StepUpController
  confirm: ConfirmController
}>()

const emit = defineEmits<{ (e: 'saved', value: ProvisioningSettings): void }>()

const { t } = useI18n()
const save = useClaudexSave('claudexDevices')

const base = ref<ProvisioningSettings>(normalizeProvisioning(props.settings))
const form = reactive<ProvisioningForm>(settingsToForm(base.value))
const initial = ref(JSON.stringify(settingsToForm(base.value)))
const attempted = ref(false)

watch(
  () => props.settings,
  (next) => {
    base.value = normalizeProvisioning(next)
    Object.assign(form, settingsToForm(base.value))
    initial.value = JSON.stringify(settingsToForm(base.value))
    attempted.value = false
  }
)

const dirty = computed(() => JSON.stringify(form) !== initial.value)
watch(dirty, (isDirty) => {
  if (isDirty) save.reset()
})

const errors = computed<ProvisioningErrors>(() => validateProvisioning(form))
/** Problems show after the first save attempt (and the sign-up one right away). */
const shownErrors = computed<ProvisioningErrors>(() =>
  attempted.value ? errors.value : { grantDefaultGroup: errors.value.grantDefaultGroup }
)

const strategyOptions = computed(() => [
  {
    value: 'subscription_then_default' as const,
    label: t('admin.claudexDevices.provisioning.strategySubscription'),
    hint: t('admin.claudexDevices.provisioning.strategySubscriptionHint')
  },
  {
    value: 'fixed' as const,
    label: t('admin.claudexDevices.provisioning.strategyFixed'),
    hint: t('admin.claudexDevices.provisioning.strategyFixedHint')
  }
])

const defaultGroup = computed(() => props.groups.find((g) => g.id === form.defaultGroupId))

const defaultGroupOptions = computed(() => {
  const options = props.groups.map((g) => ({ id: g.id, label: g.name }))
  if (form.defaultGroupId !== null && !defaultGroup.value) {
    options.push({
      id: form.defaultGroupId,
      label: t('admin.claudexDevices.provisioning.missingGroup', { id: form.defaultGroupId })
    })
  }
  return options
})

type KeyField = 'quotaUsd' | 'expiresInDays' | 'rateLimit5h' | 'rateLimit1d' | 'rateLimit7d'
const keyFields = computed<{ key: KeyField; label: string; min: number; step: string; placeholder: string }[]>(() => [
  { key: 'quotaUsd', label: t('admin.claudexDevices.provisioning.quotaUsd'), min: 0, step: 'any', placeholder: '0' },
  {
    key: 'expiresInDays',
    label: t('admin.claudexDevices.provisioning.expiresInDays'),
    min: 1,
    step: '1',
    placeholder: t('admin.claudexDevices.provisioning.never')
  },
  { key: 'rateLimit5h', label: t('admin.claudexDevices.provisioning.rateLimit5h'), min: 0, step: 'any', placeholder: '0' },
  { key: 'rateLimit1d', label: t('admin.claudexDevices.provisioning.rateLimit1d'), min: 0, step: 'any', placeholder: '0' },
  { key: 'rateLimit7d', label: t('admin.claudexDevices.provisioning.rateLimit7d'), min: 0, step: 'any', placeholder: '0' }
])

const changeLabels = computed<Record<string, string>>(() => ({
  enabled: form.enabled
    ? t('admin.claudexDevices.provisioning.changes.enabledOn')
    : t('admin.claudexDevices.provisioning.changes.enabledOff'),
  strategy: t('admin.claudexDevices.provisioning.changes.strategy'),
  defaultGroup: t('admin.claudexDevices.provisioning.changes.defaultGroup'),
  allowedGroups: t('admin.claudexDevices.provisioning.changes.allowedGroups'),
  grantDefaultGroup: form.grantDefaultGroup
    ? t('admin.claudexDevices.provisioning.changes.grantOn')
    : t('admin.claudexDevices.provisioning.changes.grantOff'),
  keyDefaults: t('admin.claudexDevices.provisioning.changes.keyDefaults'),
  maxDevicesPerUser: t('admin.claudexDevices.provisioning.changes.maxDevices', {
    count: String(form.maxDevicesPerUser ?? '')
  }),
  userApiKeys: form.userApiKeysEnabled
    ? t('admin.claudexDevices.provisioning.changes.userApiKeysOn')
    : t('admin.claudexDevices.provisioning.changes.userApiKeysOff')
}))

async function submit() {
  attempted.value = true
  if (Object.keys(errors.value).length > 0) return
  const next = formToSettings(form, base.value)
  const changes = provisioningChanges(base.value, next)
  if (changes.length === 0) {
    // Only formatting changed (e.g. a field emptied back to its default): nothing to save.
    Object.assign(form, settingsToForm(base.value))
    attempted.value = false
    return
  }
  const ok = await props.confirm.ask({
    title: t('admin.claudexDevices.provisioning.confirmTitle'),
    message: t('admin.claudexDevices.provisioning.confirmMessage'),
    confirmText: t('admin.claudexDevices.provisioning.confirmSave'),
    details: changes.map((change) => changeLabels.value[change])
  })
  if (!ok) return
  const result = await save.run(() => props.stepUp.run(() => updateProvisioning(next)))
  if (!result.ok) return
  const saved = normalizeProvisioning(result.value ?? next)
  base.value = saved
  Object.assign(form, settingsToForm(saved))
  initial.value = JSON.stringify(settingsToForm(saved))
  attempted.value = false
  emit('saved', saved)
}
</script>
