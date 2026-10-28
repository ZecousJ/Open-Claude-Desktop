<!--
  CLAUDEX: device list of /admin/claudex/devices (GET /admin/claudex/devices)
  with filters, revoke, revoke all for a user, and per-user device limits.
  Every write asks for confirmation and goes through step-up.
-->
<template>
  <section class="card" data-testid="claudex-device-table">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexDevices.list.title') }}
      </h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexDevices.list.description') }}</p>
    </div>

    <div class="card-body space-y-4">
      <!-- Filters -->
      <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto] md:items-end">
        <UserSearchSelect v-model="userFilter" :label="t('admin.claudexDevices.list.filterUser')" />
        <div>
          <label for="claudex-device-search" class="input-label mb-1.5 block">{{
            t('admin.claudexDevices.list.search')
          }}</label>
          <input
            id="claudex-device-search"
            v-model="search"
            type="search"
            class="input w-full"
            :placeholder="t('admin.claudexDevices.list.searchPlaceholder')"
            data-testid="claudex-device-search"
            @input="onSearchInput"
          />
        </div>
        <div>
          <label for="claudex-device-status" class="input-label mb-1.5 block">{{
            t('admin.claudexDevices.list.status')
          }}</label>
          <select
            id="claudex-device-status"
            v-model="status"
            class="input w-full"
            data-testid="claudex-device-status"
            @change="reload(1)"
          >
            <option value="active">{{ t('admin.claudexDevices.list.statusActive') }}</option>
            <option value="revoked">{{ t('admin.claudexDevices.list.statusRevoked') }}</option>
            <option value="all">{{ t('admin.claudexDevices.list.statusAll') }}</option>
          </select>
        </div>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="loading"
          :title="t('admin.claudex.common.reload')"
          data-testid="claudex-device-reload"
          @click="reload()"
        >
          <Icon name="refresh" size="md" :class="loading ? 'animate-spin' : ''" />
        </button>
      </div>

      <!-- Selected user -->
      <div
        v-if="userFilter"
        class="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-dark-600 dark:bg-dark-800 sm:flex-row sm:items-center sm:justify-between"
        data-testid="claudex-device-user-bar"
      >
        <span class="text-gray-700 dark:text-gray-300">
          {{ t('admin.claudexDevices.list.userBar', { user: userLabel(userFilter) }) }}
        </span>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            data-testid="claudex-device-user-limit"
            @click="openLimit(userFilter)"
          >
            {{ t('admin.claudexDevices.actions.deviceLimit') }}
          </button>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            data-testid="claudex-device-user-revoke-all"
            @click="revokeAll(userFilter)"
          >
            {{ t('admin.claudexDevices.actions.revokeAll') }}
          </button>
        </div>
      </div>

      <div
        v-if="loadError"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-device-load-error"
      >
        {{ loadError }}
      </div>

      <!-- Table -->
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('admin.claudexDevices.columns.user') }}</th>
              <th>{{ t('admin.claudexDevices.columns.device') }}</th>
              <th>{{ t('admin.claudexDevices.columns.platform') }}</th>
              <th>{{ t('admin.claudexDevices.columns.appVersion') }}</th>
              <th>{{ t('admin.claudexDevices.columns.planGroup') }}</th>
              <th>{{ t('admin.claudexDevices.columns.key') }}</th>
              <th>{{ t('admin.claudexDevices.columns.lastSeen') }}</th>
              <th>{{ t('admin.claudexDevices.columns.status') }}</th>
              <th class="text-right">{{ t('admin.claudexDevices.columns.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && devices.length === 0">
              <td colspan="9" class="py-8 text-center text-gray-500">{{ t('admin.claudex.common.loading') }}</td>
            </tr>
            <tr v-else-if="devices.length === 0">
              <td colspan="9" class="py-8 text-center text-gray-500" data-testid="claudex-device-empty">
                {{ t('admin.claudexDevices.list.empty') }}
              </td>
            </tr>
            <tr v-for="device in devices" :key="device.id" data-testid="claudex-device-row">
              <td class="max-w-[14rem]">
                <RouterLink
                  to="/admin/users"
                  class="block truncate text-primary-600 hover:underline dark:text-primary-400"
                  :title="device.user_email"
                >
                  {{ device.user_email || t('admin.claudexDevices.userSearch.userId', { id: device.user_id }) }}
                </RouterLink>
                <span class="text-xs text-gray-400">#{{ device.user_id }}</span>
              </td>
              <td class="max-w-[14rem]">
                <span class="block truncate font-medium text-gray-900 dark:text-white" :title="device.device_name">
                  {{ device.device_name || t('admin.claudexDevices.list.unnamed') }}
                </span>
                <span class="text-xs text-gray-400">{{
                  t('admin.claudexDevices.list.registered', { date: formatDateTime(device.created_at) })
                }}</span>
              </td>
              <td class="whitespace-nowrap">
                {{ platformLabel(device.platform) }}
                <span v-if="device.arch" class="text-xs text-gray-400">· {{ device.arch }}</span>
              </td>
              <td class="whitespace-nowrap font-mono text-xs">{{ device.app_version || '—' }}</td>
              <td class="whitespace-nowrap">{{ device.group_name || (device.group_id ? `#${device.group_id}` : '—') }}</td>
              <td class="whitespace-nowrap">
                <span class="font-mono text-xs">{{ device.api_key_hint || '—' }}</span>
                <span
                  v-if="device.api_key_status"
                  class="badge ml-1"
                  :class="device.api_key_status === 'active' ? 'badge-success' : 'badge-gray'"
                  >{{ keyStatusLabel(device.api_key_status) }}</span
                >
                <span class="block text-xs text-gray-400">{{
                  device.api_key_last_used_at
                    ? t('admin.claudexDevices.list.keyLastUsed', {
                        time: formatRelativeTime(device.api_key_last_used_at)
                      })
                    : t('admin.claudexDevices.list.keyNeverUsed')
                }}</span>
              </td>
              <td class="whitespace-nowrap">
                <span :title="formatDateTime(device.last_seen_at)">{{
                  device.last_seen_at ? formatRelativeTime(device.last_seen_at) : '—'
                }}</span>
                <span v-if="device.last_ip" class="block font-mono text-xs text-gray-400">{{ device.last_ip }}</span>
              </td>
              <td class="whitespace-nowrap">
                <span v-if="!device.revoked_at" class="badge badge-success">{{
                  t('admin.claudexDevices.list.statusActive')
                }}</span>
                <template v-else>
                  <span class="badge badge-danger">{{ t('admin.claudexDevices.list.revoked') }}</span>
                  <span class="block text-xs text-gray-400">{{ revokedReasonLabel(device.revoked_reason) }}</span>
                  <span class="block text-xs text-gray-400">{{ formatDateTime(device.revoked_at) }}</span>
                </template>
              </td>
              <td class="whitespace-nowrap text-right">
                <div class="inline-flex items-center gap-1">
                  <button
                    v-if="!device.revoked_at"
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                    :title="t('admin.claudexDevices.actions.revoke')"
                    :aria-label="t('admin.claudexDevices.actions.revoke')"
                    data-testid="claudex-device-revoke"
                    @click="revoke(device)"
                  >
                    <Icon name="ban" size="sm" />
                  </button>
                  <button
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                    :title="t('admin.claudexDevices.actions.revokeAll')"
                    :aria-label="t('admin.claudexDevices.actions.revokeAll')"
                    data-testid="claudex-device-revoke-all"
                    @click="revokeAll(rowUser(device))"
                  >
                    <Icon name="lock" size="sm" />
                  </button>
                  <button
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                    :title="t('admin.claudexDevices.actions.deviceLimit')"
                    :aria-label="t('admin.claudexDevices.actions.deviceLimit')"
                    data-testid="claudex-device-limit"
                    @click="openLimit(rowUser(device))"
                  >
                    <Icon name="cog" size="sm" />
                  </button>
                  <button
                    v-if="userFilter?.id !== device.user_id"
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                    :title="t('admin.claudexDevices.actions.showUser')"
                    :aria-label="t('admin.claudexDevices.actions.showUser')"
                    data-testid="claudex-device-show-user"
                    @click="filterByUser(rowUser(device))"
                  >
                    <Icon name="filter" size="sm" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Pagination
        v-if="total > pageSize"
        :total="total"
        :page="page"
        :page-size="pageSize"
        :show-page-size-selector="false"
        @update:page="reload"
      />
    </div>

    <DeviceLimitDialog
      :show="limitUser !== null"
      :user="limitUser"
      :step-up="stepUp"
      :confirm="confirm"
      @close="limitUser = null"
      @changed="onLimitChanged"
    />
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import Icon from '@/components/icons/Icon.vue'
import Pagination from '@/components/common/Pagination.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import type { StepUpController } from '@/composables/useStepUp'
import { useAppStore } from '@/stores'
import {
  listDevices,
  revokeAllDevices,
  revokeDevice,
  type AdminDevice,
  type DeviceLimit,
  type DeviceRevokedReason,
  type DeviceStatusFilter
} from '@/api/admin/claudex/devices'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { formatDateTime, formatRelativeTime } from '@/utils/format'
import DeviceLimitDialog from './DeviceLimitDialog.vue'
import UserSearchSelect from './UserSearchSelect.vue'
import type { ConfirmController } from './useConfirm'
import type { PickedUser } from './types'

const props = defineProps<{
  stepUp: StepUpController
  confirm: ConfirmController
}>()

const { t, te } = useI18n()
const appStore = useAppStore()
const action = useClaudexSave('claudexDevices')

const devices = ref<AdminDevice[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const userFilter = ref<PickedUser | null>(null)
const search = ref('')
const status = ref<DeviceStatusFilter>('active')
const limitUser = ref<PickedUser | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let seq = 0

async function reload(toPage?: number) {
  if (typeof toPage === 'number') page.value = toPage
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const result = await listDevices({
      user_id: userFilter.value?.id ?? null,
      q: search.value,
      status: status.value,
      page: page.value,
      page_size: pageSize
    })
    if (mine !== seq) return
    devices.value = result.items ?? []
    total.value = result.total ?? devices.value.length
  } catch (err) {
    if (mine !== seq) return
    loadError.value = claudexErrorMessage(err, t, te, 'claudexDevices', t('admin.claudexDevices.list.loadFailed'))
  } finally {
    if (mine === seq) loading.value = false
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void reload(1), 300)
}

function userLabel(user: PickedUser): string {
  return user.email || t('admin.claudexDevices.userSearch.userId', { id: user.id })
}

function rowUser(device: AdminDevice): PickedUser {
  return { id: device.user_id, email: device.user_email }
}

function filterByUser(user: PickedUser) {
  userFilter.value = user
}

watch(
  () => userFilter.value?.id,
  () => void reload(1)
)

function platformLabel(platform: string): string {
  const key = `admin.claudexDevices.platforms.${platform}`
  return platform && te(key) ? t(key) : platform || '—'
}

function keyStatusLabel(value: string): string {
  const key = `admin.claudexDevices.keyStatus.${value}`
  return te(key) ? t(key) : value
}

function revokedReasonLabel(reason: DeviceRevokedReason): string {
  const key = `admin.claudexDevices.revokedReason.${reason || 'unknown'}`
  return te(key) ? t(key) : reason
}

function reportFailure(result: { ok: boolean; cancelled?: boolean }) {
  if (!result.ok && !result.cancelled && action.error.value) appStore.showError(action.error.value)
}

async function revoke(device: AdminDevice) {
  const ok = await props.confirm.ask({
    title: t('admin.claudexDevices.confirm.revokeTitle'),
    message: t('admin.claudexDevices.confirm.revokeMessage', {
      device: device.device_name || t('admin.claudexDevices.list.unnamed'),
      user: userLabel(rowUser(device))
    }),
    confirmText: t('admin.claudexDevices.actions.revoke'),
    danger: true
  })
  if (!ok) return
  const result = await action.run(() => props.stepUp.run(() => revokeDevice(device.id)))
  if (result.ok) {
    appStore.showSuccess(t('admin.claudexDevices.confirm.revoked'))
    await reload()
  } else reportFailure(result)
}

async function revokeAll(user: PickedUser) {
  const ok = await props.confirm.ask({
    title: t('admin.claudexDevices.confirm.revokeAllTitle', { user: userLabel(user) }),
    message: t('admin.claudexDevices.confirm.revokeAllMessage'),
    confirmText: t('admin.claudexDevices.actions.revokeAll'),
    danger: true
  })
  if (!ok) return
  const result = await action.run(() => props.stepUp.run(() => revokeAllDevices(user.id)))
  if (result.ok) {
    appStore.showSuccess(t('admin.claudexDevices.confirm.revokedAll', { count: result.value.revoked ?? 0 }))
    await reload()
  } else reportFailure(result)
}

function openLimit(user: PickedUser) {
  limitUser.value = user
}

function onLimitChanged(limit: DeviceLimit) {
  appStore.showSuccess(t('admin.claudexDevices.limit.saved', { count: limit.max_devices }))
  limitUser.value = null
}

onMounted(() => void reload(1))
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

defineExpose({ reload })
</script>
