<!--
  CLAUDEX: look at one user's usage limits the way the Claudex app shows them
  (GET /admin/claudex/users/:user_id/usage-status, same data as the user's
  GET /api/v1/claudex/usage-status). Read-only.
-->
<template>
  <section class="card" data-testid="claudex-usage-status-card">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexUsageRules.status.title') }}
      </h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexUsageRules.status.description') }}</p>
    </div>
    <div class="card-body space-y-4">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] md:items-end">
        <UserSearchSelect v-model="user" :label="t('admin.claudexUsageRules.status.user')" />
        <div>
          <label for="claudex-status-group" class="input-label mb-1.5 block">{{
            t('admin.claudexUsageRules.status.group')
          }}</label>
          <select
            id="claudex-status-group"
            v-model="groupId"
            class="input w-full"
            data-testid="claudex-status-group"
          >
            <option :value="null">{{ t('admin.claudexUsageRules.status.planGroup') }}</option>
            <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
        </div>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="!user || loading"
          data-testid="claudex-status-load"
          @click="load"
        >
          <Icon name="refresh" size="sm" class="mr-1" :class="loading ? 'animate-spin' : ''" />
          {{ t('admin.claudexUsageRules.status.show') }}
        </button>
      </div>

      <div
        v-if="error"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-status-error"
      >
        {{ error }}
      </div>

      <div v-if="status" class="space-y-3" data-testid="claudex-status-result">
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
          <span>
            {{ t('admin.claudexUsageRules.status.plan') }}:
            <span class="font-medium">{{ status.plan?.group_name || t('admin.claudexUsageRules.status.noPlan') }}</span>
          </span>
          <span v-if="status.balance">
            {{ t('admin.claudexUsageRules.status.balance') }}:
            <span class="font-medium">{{ formatUsd(status.balance.balance_usd) }}</span>
          </span>
          <span v-if="status.updated_at" class="text-gray-400">{{
            t('admin.claudexUsageRules.status.updatedAt', { time: formatDateTime(status.updated_at) })
          }}</span>
        </div>

        <div
          v-if="status.blocked?.blocked"
          role="alert"
          class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
          data-testid="claudex-status-blocked"
        >
          {{
            status.blocked.resets_at
              ? t('admin.claudexUsageRules.status.blockedUntil', { time: formatDateTime(status.blocked.resets_at) })
              : t('admin.claudexUsageRules.status.blocked')
          }}
        </div>

        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>{{ t('admin.claudexUsageRules.status.limit') }}</th>
                <th>{{ t('admin.claudexUsageRules.columns.window') }}</th>
                <th>{{ t('admin.claudexUsageRules.status.used') }}</th>
                <th>{{ t('admin.claudexUsageRules.status.resets') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="status.windows.length === 0">
                <td colspan="4" class="py-6 text-center text-gray-500" data-testid="claudex-status-empty">
                  {{ t('admin.claudexUsageRules.status.empty') }}
                </td>
              </tr>
              <tr v-for="item in status.windows" :key="item.id" data-testid="claudex-status-window">
                <td>
                  <span class="font-medium text-gray-900 dark:text-white">{{ item.label }}</span>
                  <span class="badge badge-gray ml-1">{{ sourceLabel(item.source) }}</span>
                  <span v-if="item.models?.length" class="block font-mono text-xs text-gray-400">{{
                    item.models.join(', ')
                  }}</span>
                </td>
                <td class="whitespace-nowrap">{{ windowText(item.window_seconds) }}</td>
                <td class="min-w-[12rem]">
                  <div class="flex items-center justify-between text-xs">
                    <span :class="item.exceeded ? 'font-medium text-red-600 dark:text-red-400' : ''">
                      {{ formatUsd(item.used_usd) }} / {{ formatUsd(item.limit_usd) }}
                    </span>
                    <span class="text-gray-400">{{ item.percent }}%</span>
                  </div>
                  <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-dark-700">
                    <div
                      class="h-full rounded-full"
                      :class="item.exceeded ? 'bg-red-500' : item.percent >= 80 ? 'bg-amber-500' : 'bg-primary-500'"
                      :style="{ width: `${Math.min(100, Math.max(0, item.percent))}%` }"
                    ></div>
                  </div>
                </td>
                <td class="whitespace-nowrap text-xs">
                  {{
                    item.active && item.resets_at
                      ? formatDateTime(item.resets_at)
                      : t('admin.claudexUsageRules.status.notStarted')
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-else-if="!user" class="text-sm text-gray-500">{{ t('admin.claudexUsageRules.status.pickUser') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { getUserUsageStatus, type UsageStatus } from '@/api/admin/claudex/usageRules'
import type { AdminGroup } from '@/types'
import { formatDateTime } from '@/utils/format'
import UserSearchSelect from '@/components/admin/claudex/devices/UserSearchSelect.vue'
import type { PickedUser } from '@/components/admin/claudex/devices/types'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { formatUsd, windowLabel } from './rules'

defineProps<{ groups: AdminGroup[] }>()

const { t, te } = useI18n()
const user = ref<PickedUser | null>(null)
const groupId = ref<number | null>(null)
const status = ref<UsageStatus | null>(null)
const loading = ref(false)
const error = ref('')
let seq = 0

function windowText(seconds: number): string {
  const label = windowLabel(seconds)
  return t(label.key, label.params ?? {})
}

function sourceLabel(source: string): string {
  const key = `admin.claudexUsageRules.status.sources.${source}`
  return te(key) ? t(key) : source
}

async function load() {
  const picked = user.value
  if (!picked) return
  const mine = ++seq
  loading.value = true
  error.value = ''
  try {
    const result = await getUserUsageStatus(picked.id, groupId.value)
    if (mine !== seq) return
    status.value = { ...result, windows: result?.windows ?? [] }
  } catch (err) {
    if (mine !== seq) return
    status.value = null
    error.value = claudexErrorMessage(
      err,
      t,
      te,
      'claudexUsageRules',
      t('admin.claudexUsageRules.status.loadFailed')
    )
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch([() => user.value?.id, groupId], () => {
  status.value = null
  error.value = ''
  if (user.value) void load()
})
</script>
