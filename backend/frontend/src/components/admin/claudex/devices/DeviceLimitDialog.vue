<!--
  CLAUDEX: one user's device limit (GET/PUT/DELETE
  /admin/claudex/users/:user_id/device-limit). Shows the current value and
  where it comes from; setting a value or going back to the default asks for
  confirmation and step-up.
-->
<template>
  <BaseDialog
    :show="show"
    :title="t('admin.claudexDevices.limit.title')"
    width="narrow"
    @close="emit('close')"
  >
    <div class="space-y-4" data-testid="claudex-device-limit-dialog">
      <p class="text-sm text-gray-700 dark:text-gray-300">
        <span class="font-medium">{{ userLabel }}</span>
        <span class="ml-1 text-xs text-gray-400">#{{ user?.id }}</span>
      </p>

      <div v-if="loading" class="py-4 text-center text-sm text-gray-500">{{ t('admin.claudex.common.loading') }}</div>
      <div
        v-else-if="loadError"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-device-limit-load-error"
      >
        {{ loadError }}
        <button type="button" class="btn btn-secondary btn-sm ml-2" @click="load">
          {{ t('admin.claudex.common.retry') }}
        </button>
      </div>
      <template v-else-if="limit">
        <dl class="grid grid-cols-2 gap-3 text-sm" data-testid="claudex-device-limit-current">
          <div>
            <dt class="text-xs text-gray-500">{{ t('admin.claudexDevices.limit.current') }}</dt>
            <dd class="font-medium text-gray-900 dark:text-white">
              {{ limit.max_devices }}
              <span class="ml-1 text-xs font-normal text-gray-500">{{
                limit.source === 'user'
                  ? t('admin.claudexDevices.limit.sourceUser')
                  : t('admin.claudexDevices.limit.sourceDefault')
              }}</span>
            </dd>
          </div>
          <div>
            <dt class="text-xs text-gray-500">{{ t('admin.claudexDevices.limit.active') }}</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ limit.active_devices }}</dd>
          </div>
        </dl>

        <div>
          <label for="claudex-device-limit-input" class="input-label">{{
            t('admin.claudexDevices.limit.newValue')
          }}</label>
          <input
            id="claudex-device-limit-input"
            v-model="value"
            type="number"
            :min="MAX_DEVICES_MIN"
            :max="MAX_DEVICES_MAX"
            step="1"
            class="input mt-1.5 w-32"
            :class="{ 'input-error': attempted && !valid }"
            data-testid="claudex-device-limit-input"
          />
          <p v-if="attempted && !valid" class="input-error-text mt-1.5">
            {{ t('admin.claudexDevices.validation.maxDevices') }}
          </p>
          <p v-else class="input-hint mt-1.5">
            {{ t('admin.claudexDevices.limit.hint', { default: limit.default }) }}
          </p>
        </div>

        <p v-if="action.error.value" role="alert" class="text-sm text-red-600 dark:text-red-400">
          {{ action.error.value }}
        </p>
      </template>
    </div>

    <template #footer>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn btn-secondary" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="!limit || limit.source !== 'user' || action.saving.value"
          data-testid="claudex-device-limit-reset"
          @click="resetToDefault"
        >
          {{ t('admin.claudexDevices.limit.useDefault') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!limit || action.saving.value"
          data-testid="claudex-device-limit-save"
          @click="saveLimit"
        >
          {{ action.saving.value ? t('admin.claudex.common.saving') : t('admin.claudexDevices.limit.save') }}
        </button>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import type { StepUpController } from '@/composables/useStepUp'
import {
  getDeviceLimit,
  resetDeviceLimit,
  setDeviceLimit,
  type DeviceLimit
} from '@/api/admin/claudex/devices'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { MAX_DEVICES_MAX, MAX_DEVICES_MIN, parseNumber, validMaxDevices, type NumberInput } from './provisioning'
import type { ConfirmController } from './useConfirm'
import type { PickedUser } from './types'

const props = defineProps<{
  show: boolean
  user: PickedUser | null
  stepUp: StepUpController
  confirm: ConfirmController
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'changed', value: DeviceLimit): void
}>()

const { t, te } = useI18n()
const action = useClaudexSave('claudexDevices')
const limit = ref<DeviceLimit | null>(null)
const loading = ref(false)
const loadError = ref('')
const value = ref<NumberInput>(null)
const attempted = ref(false)

const userLabel = computed(() =>
  props.user?.email || t('admin.claudexDevices.userSearch.userId', { id: props.user?.id ?? '' })
)
const valid = computed(() => validMaxDevices(value.value))

async function load() {
  if (!props.user) return
  loading.value = true
  loadError.value = ''
  action.reset()
  try {
    limit.value = await getDeviceLimit(props.user.id)
    value.value = limit.value.max_devices
  } catch (err) {
    limit.value = null
    // A user picked by ID may not exist: show the page's CLAUDEX_USER_NOT_FOUND text, not the server's English.
    loadError.value = claudexErrorMessage(err, t, te, 'claudexDevices', t('admin.claudexDevices.limit.loadFailed'))
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.user?.id] as const,
  ([show]) => {
    attempted.value = false
    if (show) void load()
  },
  { immediate: true }
)

async function saveLimit() {
  attempted.value = true
  if (!props.user || !limit.value || !valid.value) return
  const next = parseNumber(value.value) as number
  const user = props.user
  const ok = await props.confirm.ask({
    title: t('admin.claudexDevices.limit.confirmSetTitle'),
    message: t('admin.claudexDevices.limit.confirmSetMessage', { user: userLabel.value, count: next }),
    confirmText: t('admin.claudexDevices.limit.save')
  })
  if (!ok) return
  const result = await action.run(() => props.stepUp.run(() => setDeviceLimit(user.id, next)))
  if (result.ok) {
    limit.value = result.value
    emit('changed', result.value)
  }
}

async function resetToDefault() {
  if (!props.user || !limit.value) return
  const user = props.user
  const ok = await props.confirm.ask({
    title: t('admin.claudexDevices.limit.confirmResetTitle'),
    message: t('admin.claudexDevices.limit.confirmResetMessage', {
      user: userLabel.value,
      count: limit.value.default
    }),
    confirmText: t('admin.claudexDevices.limit.useDefault')
  })
  if (!ok) return
  const result = await action.run(() => props.stepUp.run(() => resetDeviceLimit(user.id)))
  if (result.ok) {
    limit.value = result.value
    value.value = result.value.max_devices
    emit('changed', result.value)
  }
}
</script>
