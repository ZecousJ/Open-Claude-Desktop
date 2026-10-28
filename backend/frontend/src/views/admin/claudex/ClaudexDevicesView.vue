<!--
  CLAUDEX: /admin/claudex/devices (K3). Device key provisioning (setting
  claudex_provisioning), the list of Claudex desktop devices with revoke and
  revoke-all, per-user device limits, and the API keys an administrator
  manages for a user (R13: users can't create their own while
  user_api_keys_enabled is off). Backend: B4 (internal/claudex/devices).
  Every write goes through step-up; revokes, deletes and setting changes are
  confirmed first.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexDevices.title')"
    :description="t('admin.claudexDevices.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-devices-page"
    @retry="load"
  >
    <div class="space-y-6">
      <ProvisioningCard
        v-if="settings"
        :settings="settings"
        :groups="groups"
        :step-up="stepUp"
        :confirm="confirm"
        @saved="settings = $event"
      />
      <DeviceTable :step-up="stepUp" :confirm="confirm" />

      <section class="card" data-testid="claudex-user-keys-card">
        <div class="card-header">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexDevices.userKeys.title') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexDevices.userKeys.description') }}
          </p>
        </div>
        <div class="card-body space-y-4">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,24rem)_auto] md:items-end">
            <UserSearchSelect v-model="keyUser" :label="t('admin.claudexDevices.list.filterUser')" />
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="btn btn-primary"
                :disabled="!keyUser"
                data-testid="claudex-user-keys-create"
                @click="createOpen = true"
              >
                {{ t('admin.claudexDevices.userKeys.createButton') }}
              </button>
              <button
                v-if="keyUser"
                type="button"
                class="btn btn-secondary"
                :disabled="keysLoading"
                :title="t('admin.claudex.common.reload')"
                data-testid="claudex-user-keys-reload"
                @click="loadKeys"
              >
                <Icon name="refresh" size="md" :class="keysLoading ? 'animate-spin' : ''" />
              </button>
            </div>
          </div>

          <p v-if="!keyUser" class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-user-keys-pick">
            {{ t('admin.claudexDevices.userKeys.pickUser') }}
          </p>
          <template v-else>
            <div
              v-if="keysError"
              role="alert"
              class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
              data-testid="claudex-user-keys-error"
            >
              {{ keysError }}
            </div>
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ t('admin.claudexDevices.userKeys.columns.name') }}</th>
                    <th>{{ t('admin.claudexDevices.userKeys.columns.key') }}</th>
                    <th>{{ t('admin.claudexDevices.userKeys.columns.group') }}</th>
                    <th>{{ t('admin.claudexDevices.userKeys.columns.quota') }}</th>
                    <th>{{ t('admin.claudexDevices.userKeys.columns.expires') }}</th>
                    <th>{{ t('admin.claudexDevices.userKeys.columns.lastUsed') }}</th>
                    <th>{{ t('admin.claudexDevices.columns.status') }}</th>
                    <th class="text-right">{{ t('admin.claudexDevices.columns.actions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="keysLoading && userKeys.length === 0">
                    <td colspan="8" class="py-6 text-center text-gray-500">{{ t('admin.claudex.common.loading') }}</td>
                  </tr>
                  <tr v-else-if="userKeys.length === 0">
                    <td colspan="8" class="py-6 text-center text-gray-500" data-testid="claudex-user-keys-empty">
                      {{ t('admin.claudexDevices.userKeys.empty') }}
                    </td>
                  </tr>
                  <tr v-for="key in userKeys" :key="key.id" data-testid="claudex-user-key-row">
                    <td class="max-w-[14rem]">
                      <span class="block truncate font-medium text-gray-900 dark:text-white" :title="key.name">
                        {{ key.name }}
                      </span>
                      <span class="text-xs text-gray-400">
                        {{ t('admin.claudexDevices.list.registered', { date: formatDateTime(key.created_at) }) }}
                      </span>
                    </td>
                    <td class="whitespace-nowrap font-mono text-xs">{{ key.key_hint || '—' }}</td>
                    <td class="whitespace-nowrap">
                      {{ key.group_name || (key.group_id ? `#${key.group_id}` : '—') }}
                    </td>
                    <td class="whitespace-nowrap tabular-nums">{{ quotaText(key) }}</td>
                    <td class="whitespace-nowrap">
                      {{ key.expires_at ? formatDateTime(key.expires_at) : t('admin.claudexDevices.provisioning.never') }}
                    </td>
                    <td class="whitespace-nowrap">
                      {{
                        key.last_used_at
                          ? formatRelativeTime(key.last_used_at)
                          : t('admin.claudexDevices.list.keyNeverUsed')
                      }}
                    </td>
                    <td class="whitespace-nowrap">
                      <span class="badge" :class="key.status === 'active' ? 'badge-success' : 'badge-gray'">
                        {{ keyStatusLabel(key.status) }}
                      </span>
                    </td>
                    <td class="whitespace-nowrap text-right">
                      <button
                        type="button"
                        class="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                        :title="t('admin.claudexDevices.userKeys.delete')"
                        :aria-label="t('admin.claudexDevices.userKeys.delete')"
                        :disabled="keyAction.saving.value"
                        data-testid="claudex-user-key-delete"
                        @click="deleteKey(key)"
                      >
                        <Icon name="trash" size="sm" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </section>
    </div>
  </ClaudexPageShell>

  <CreateUserKeyDialog
    :show="createOpen"
    :user="keyUser"
    :groups="groups"
    :step-up="stepUp"
    @close="createOpen = false"
    @created="onKeyCreated"
  />

  <ConfirmDialog
    :show="confirm.state.show"
    :title="confirm.state.title"
    :message="confirm.state.message"
    :confirm-text="confirm.state.confirmText || undefined"
    :danger="confirm.state.danger"
    :z-index="55"
    @confirm="confirm.accept"
    @cancel="confirm.cancel"
  >
    <ul
      v-if="confirm.state.details.length"
      class="list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300"
      data-testid="claudex-confirm-details"
    >
      <li v-for="line in confirm.state.details" :key="line">{{ line }}</li>
    </ul>
  </ConfirmDialog>
  <TotpStepUpDialog :controller="stepUp" />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Icon from '@/components/icons/Icon.vue'
import ProvisioningCard from '@/components/admin/claudex/devices/ProvisioningCard.vue'
import DeviceTable from '@/components/admin/claudex/devices/DeviceTable.vue'
import CreateUserKeyDialog from '@/components/admin/claudex/devices/CreateUserKeyDialog.vue'
import UserSearchSelect from '@/components/admin/claudex/devices/UserSearchSelect.vue'
import { normalizeProvisioning } from '@/components/admin/claudex/devices/provisioning'
import { useConfirm } from '@/components/admin/claudex/devices/useConfirm'
import type { PickedUser } from '@/components/admin/claudex/devices/types'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import { useStepUp } from '@/composables/useStepUp'
import {
  deleteUserKey,
  getProvisioning,
  listUserKeys,
  type CreatedUserKey,
  type ProvisioningSettings,
  type UserApiKey
} from '@/api/admin/claudex/devices'
import { getAll as getAllGroups } from '@/api/admin/groups'
import type { AdminGroup } from '@/types'
import { claudexErrorMessage, claudexErrorReason } from '@/components/admin/claudex/common/errors'
import { useAppStore } from '@/stores'
import { formatDateTime, formatRelativeTime } from '@/utils/format'

const { t, te } = useI18n()
const stepUp = useStepUp()
const confirm = useConfirm()
const appStore = useAppStore()

const settings = ref<ProvisioningSettings | null>(null)
const groups = ref<AdminGroup[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [provisioning, allGroups] = await Promise.all([getProvisioning(), getAllGroups()])
    settings.value = normalizeProvisioning(provisioning)
    groups.value = allGroups ?? []
  } catch (err) {
    loadError.value = claudexErrorMessage(err, t, te, 'claudexDevices', t('admin.claudex.common.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ----- User API keys (R13) -----
const keyUser = ref<PickedUser | null>(null)
const userKeys = ref<UserApiKey[]>([])
const keysLoading = ref(false)
const keysError = ref('')
const createOpen = ref(false)
const keyAction = useClaudexSave('claudexDevices')
let keysSeq = 0

async function loadKeys() {
  const user = keyUser.value
  const mine = ++keysSeq
  keysError.value = ''
  if (!user) {
    userKeys.value = []
    keysLoading.value = false
    return
  }
  keysLoading.value = true
  try {
    const items = await listUserKeys(user.id)
    if (mine !== keysSeq) return
    userKeys.value = items
  } catch (err) {
    if (mine !== keysSeq) return
    userKeys.value = []
    keysError.value = claudexErrorMessage(err, t, te, 'claudexDevices', t('admin.claudexDevices.userKeys.loadFailed'))
  } finally {
    if (mine === keysSeq) keysLoading.value = false
  }
}

watch(
  () => keyUser.value?.id,
  () => {
    // Drop the previous user's rows so none of them is shown (or deleted) under the new user.
    userKeys.value = []
    void loadKeys()
  }
)

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function formatUsd(value: number): string {
  return usdFormat.format(Number.isFinite(value) ? value : 0)
}

function quotaText(key: UserApiKey): string {
  if (!(key.quota > 0)) return t('admin.claudexDevices.userKeys.noQuota')
  return t('admin.claudexDevices.userKeys.quotaUsed', { used: formatUsd(key.quota_used), limit: formatUsd(key.quota) })
}

function keyStatusLabel(value: string): string {
  const key = `admin.claudexDevices.keyStatus.${value}`
  return te(key) ? t(key) : value
}

function onKeyCreated(key: CreatedUserKey) {
  appStore.showSuccess(t('admin.claudexDevices.userKeys.created', { name: key.name }))
  void loadKeys()
}

async function deleteKey(key: UserApiKey) {
  const user = keyUser.value
  if (!user) return
  const ok = await confirm.ask({
    title: t('admin.claudexDevices.userKeys.deleteTitle'),
    message: t('admin.claudexDevices.userKeys.deleteMessage', {
      name: key.name,
      user: user.email || t('admin.claudexDevices.userSearch.userId', { id: user.id })
    }),
    confirmText: t('admin.claudexDevices.userKeys.delete'),
    danger: true
  })
  if (!ok) return
  const result = await keyAction.run(() => runWithStepUp(stepUp, () => deleteUserKey(user.id, key.id), t))
  if (result.ok) {
    appStore.showSuccess(t('admin.claudexDevices.userKeys.deleted', { name: key.name }))
  } else if (!result.cancelled && claudexErrorReason(keyAction.lastError.value) !== 'CLAUDEX_API_KEY_NOT_FOUND') {
    // Already gone is what the administrator wanted; anything else is shown.
    if (keyAction.error.value) appStore.showError(keyAction.error.value)
  }
  await loadKeys()
}
</script>
