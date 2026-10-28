<!--
  CLAUDEX: create an API key for a user (POST /admin/claudex/users/:user_id/api-keys,
  step-up). Owner decision 17 keeps /api/v1/keys closed to regular users, so
  administrators create keys for them here. The key is a user API key: signing
  the user out of all devices never touches it. Its plaintext is shown once,
  right after it is created.
-->
<template>
  <BaseDialog :show="show" :title="t('admin.claudexDevices.userKeys.create.title')" width="normal" @close="close">
    <div v-if="created" class="space-y-4" data-testid="claudex-user-key-created">
      <p class="text-sm text-gray-700 dark:text-gray-300">
        {{ t('admin.claudexDevices.userKeys.create.createdFor', { name: created.name, user: userLabel }) }}
      </p>
      <div>
        <label :for="`${uid}-plaintext`" class="input-label">{{ t('admin.claudexDevices.userKeys.create.key') }}</label>
        <div class="mt-1.5 flex gap-2">
          <input
            :id="`${uid}-plaintext`"
            :value="created.key"
            type="text"
            readonly
            class="input w-full font-mono text-sm"
            data-testid="claudex-user-key-plaintext"
            @focus="selectAll"
          />
          <button
            type="button"
            class="btn btn-secondary shrink-0"
            data-testid="claudex-user-key-copy"
            @click="copyKey"
          >
            {{ copied ? t('admin.claudexDevices.userKeys.create.copied') : t('admin.claudexDevices.userKeys.create.copy') }}
          </button>
        </div>
      </div>
      <p
        role="note"
        class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200"
      >
        {{ t('admin.claudexDevices.userKeys.create.onceNotice') }}
      </p>
    </div>

    <form
      v-else
      :id="`${uid}-form`"
      class="space-y-4"
      novalidate
      data-testid="claudex-user-key-form"
      @submit.prevent="submit"
    >
      <p class="text-sm text-gray-700 dark:text-gray-300">
        <span class="font-medium">{{ userLabel }}</span>
        <span class="ml-1 text-xs text-gray-400">#{{ user?.id }}</span>
      </p>

      <div>
        <label :for="`${uid}-name`" class="input-label">{{ t('admin.claudexDevices.userKeys.create.name') }}</label>
        <input
          :id="`${uid}-name`"
          v-model="form.name"
          type="text"
          maxlength="100"
          class="input mt-1.5 w-full"
          :class="{ 'input-error': shownProblems.name }"
          :placeholder="t('admin.claudexDevices.userKeys.create.namePlaceholder')"
          data-testid="claudex-user-key-name"
        />
        <p v-if="shownProblems.name" class="input-error-text mt-1.5">{{ t(shownProblems.name) }}</p>
      </div>

      <div>
        <label :for="`${uid}-group`" class="input-label">{{ t('admin.claudexDevices.userKeys.create.group') }}</label>
        <select
          :id="`${uid}-group`"
          v-model="form.groupId"
          class="input mt-1.5 w-full"
          data-testid="claudex-user-key-group"
        >
          <option :value="null">{{ t('admin.claudexDevices.userKeys.create.noGroup') }}</option>
          <option v-for="group in activeGroups" :key="group.id" :value="group.id">{{ group.name }}</option>
        </select>
        <p class="input-hint mt-1.5">{{ t('admin.claudexDevices.userKeys.create.groupHint') }}</p>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label :for="`${uid}-quota`" class="input-label">{{ t('admin.claudexDevices.provisioning.quotaUsd') }}</label>
          <input
            :id="`${uid}-quota`"
            v-model="form.quota"
            type="number"
            min="0"
            step="0.01"
            class="input mt-1.5 w-full"
            :class="{ 'input-error': shownProblems.quota }"
            data-testid="claudex-user-key-quota"
          />
          <p v-if="shownProblems.quota" class="input-error-text mt-1.5">{{ t(shownProblems.quota) }}</p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexDevices.userKeys.create.quotaHint') }}</p>
        </div>
        <div>
          <label :for="`${uid}-expires`" class="input-label">{{
            t('admin.claudexDevices.provisioning.expiresInDays')
          }}</label>
          <input
            :id="`${uid}-expires`"
            v-model="form.expiresInDays"
            type="number"
            min="1"
            max="3650"
            step="1"
            class="input mt-1.5 w-full"
            :class="{ 'input-error': shownProblems.expiresInDays }"
            :placeholder="t('admin.claudexDevices.provisioning.never')"
            data-testid="claudex-user-key-expires"
          />
          <p v-if="shownProblems.expiresInDays" class="input-error-text mt-1.5">{{ t(shownProblems.expiresInDays) }}</p>
        </div>
      </div>

      <div>
        <label :for="`${uid}-ips`" class="input-label">{{ t('admin.claudexDevices.userKeys.create.ipAllowlist') }}</label>
        <textarea
          :id="`${uid}-ips`"
          v-model="form.ipAllowlist"
          rows="3"
          class="input mt-1.5 w-full font-mono text-sm"
          :class="{ 'input-error': shownProblems.ipAllowlist }"
          :placeholder="t('admin.claudexDevices.userKeys.create.ipAllowlistPlaceholder')"
          data-testid="claudex-user-key-ips"
        ></textarea>
        <p v-if="shownProblems.ipAllowlist" class="input-error-text mt-1.5">{{ t(shownProblems.ipAllowlist) }}</p>
        <p v-else class="input-hint mt-1.5">{{ t('admin.claudexDevices.userKeys.create.ipAllowlistHint') }}</p>
      </div>

      <p class="input-hint">{{ t('admin.claudexDevices.userKeys.create.userKeyNote') }}</p>

      <p v-if="action.error.value" role="alert" class="text-sm text-red-600 dark:text-red-400" data-testid="claudex-user-key-error">
        {{ action.error.value }}
      </p>
    </form>

    <template #footer>
      <div class="flex justify-end gap-2">
        <template v-if="created">
          <button type="button" class="btn btn-primary" data-testid="claudex-user-key-done" @click="close">
            {{ t('admin.claudexDevices.userKeys.create.done') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-secondary" :disabled="action.saving.value" @click="close">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            :form="`${uid}-form`"
            class="btn btn-primary"
            :disabled="action.saving.value || !user"
            data-testid="claudex-user-key-submit"
          >
            {{
              action.saving.value
                ? t('admin.claudexDevices.userKeys.create.creating')
                : t('admin.claudexDevices.userKeys.create.submit')
            }}
          </button>
        </template>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import { useClipboard } from '@/composables/useClipboard'
import type { StepUpController } from '@/composables/useStepUp'
import { createUserKey, type CreatedUserKey, type CreateUserKeyInput } from '@/api/admin/claudex/devices'
import type { AdminGroup } from '@/types'
import { parseNumber, type NumberInput } from './provisioning'
import type { PickedUser } from './types'

const props = withDefaults(
  defineProps<{
    show: boolean
    user: PickedUser | null
    groups?: AdminGroup[]
    stepUp: StepUpController
  }>(),
  { groups: () => [] }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', key: CreatedUserKey): void
}>()

const { t } = useI18n()
const uid = `claudex-user-key-${useId()}`
const action = useClaudexSave('claudexDevices')
const { copied, copyToClipboard } = useClipboard()

/** Names reserved for Claudex device keys (the server refuses them too). */
const RESERVED_PREFIXES = ['claudex-device:', 'claudex-desktop:']
const MAX_IPS = 100

interface Form {
  name: string
  groupId: number | null
  quota: NumberInput
  expiresInDays: NumberInput
  ipAllowlist: string
}

const form = reactive<Form>({ name: '', groupId: null, quota: 0, expiresInDays: null, ipAllowlist: '' })
const attempted = ref(false)
const created = ref<CreatedUserKey | null>(null)

const userLabel = computed(() => props.user?.email || t('admin.claudexDevices.userSearch.userId', { id: props.user?.id ?? '' }))
const activeGroups = computed(() => props.groups.filter((group) => group.status === 'active'))

function ipLines(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

const V = 'admin.claudexDevices.userKeys.validation'

const problems = computed(() => {
  const out: Partial<Record<keyof Form, string>> = {}
  const name = form.name.trim()
  if (!name) out.name = `${V}.nameRequired`
  else if (Array.from(name).length > 100) out.name = `${V}.nameLength`
  else if (RESERVED_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))) out.name = `${V}.nameReserved`
  const quota = parseNumber(form.quota)
  if (quota !== null && (!Number.isFinite(quota) || quota < 0)) out.quota = 'admin.claudexDevices.validation.usd'
  const days = parseNumber(form.expiresInDays)
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    out.expiresInDays = 'admin.claudexDevices.validation.expiresInDays'
  }
  if (ipLines(form.ipAllowlist).length > MAX_IPS) out.ipAllowlist = `${V}.ipCount`
  return out
})

const shownProblems = computed(() => (attempted.value ? problems.value : {}))

function reset() {
  Object.assign(form, { name: '', groupId: null, quota: 0, expiresInDays: null, ipAllowlist: '' })
  attempted.value = false
  created.value = null
  action.reset()
}

watch(
  () => [props.show, props.user?.id] as const,
  ([show]) => {
    if (show) reset()
  },
  { immediate: true }
)

function close() {
  if (action.saving.value) return
  // The plaintext is dropped with the dialog: it is never shown again.
  created.value = null
  emit('close')
}

async function submit() {
  attempted.value = true
  if (!props.user || action.saving.value || Object.keys(problems.value).length > 0) return
  const user = props.user
  const input: CreateUserKeyInput = {
    name: form.name.trim(),
    group_id: form.groupId,
    quota: parseNumber(form.quota) ?? 0,
    expires_in_days: parseNumber(form.expiresInDays),
    ip_whitelist: ipLines(form.ipAllowlist)
  }
  const result = await action.run(() => runWithStepUp(props.stepUp, () => createUserKey(user.id, input), t))
  if (result.ok) {
    created.value = result.value
    emit('created', result.value)
  }
}

function selectAll(event: FocusEvent) {
  const input = event.target as HTMLInputElement | null
  input?.select()
}

async function copyKey() {
  if (created.value) await copyToClipboard(created.value.key, t('admin.claudexDevices.userKeys.create.copiedToast'))
}
</script>
