<!--
  CLAUDEX: dictation sessions relayed to the realtime transcription service
  (server GET /admin/claudex/voice/estimated-usage). Every session is billed
  from the audio it relayed, bytes / 32000 = seconds (owner decisions 6 and
  18), so every row is an estimate. Admins compare them with the usage
  records by request ID.
-->
<template>
  <div class="card" data-testid="claudex-voice-sessions">
    <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexVoice.sessions.title') }}
      </h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexVoice.sessions.description') }}
      </p>
    </div>
    <div class="space-y-4 p-6">
      <form class="flex flex-wrap items-end gap-3" data-testid="claudex-voice-sessions-filter" @submit.prevent="applyFilter">
        <div>
          <label for="claudex-voice-sessions-user" class="input-label mb-1.5 block">
            {{ t('admin.claudexVoice.sessions.userId') }}
          </label>
          <input
            id="claudex-voice-sessions-user"
            v-model="userIdInput"
            type="number"
            min="1"
            step="1"
            inputmode="numeric"
            class="input w-40"
            :placeholder="t('admin.claudexVoice.sessions.anyUser')"
            data-testid="claudex-voice-sessions-user"
          />
        </div>
        <button type="submit" class="btn btn-secondary" :disabled="loading">
          {{ t('admin.claudexVoice.sessions.apply') }}
        </button>
        <button v-if="userId !== undefined" type="button" class="btn btn-ghost" :disabled="loading" @click="clearFilter">
          {{ t('admin.claudexVoice.sessions.clear') }}
        </button>
      </form>

      <p
        v-if="error"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-voice-sessions-error"
      >
        {{ error }}
      </p>

      <DataTable :columns="columns" :data="items" :loading="loading" row-key="request_id">
        <template #cell-created_at="{ value }">
          <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
        </template>
        <template #cell-user="{ row }">
          <span class="text-sm">{{ row.user_email || `#${row.user_id}` }}</span>
          <span v-if="row.user_email" class="ml-1 text-xs text-gray-400">#{{ row.user_id }}</span>
        </template>
        <template #cell-request_id="{ value }">
          <span class="font-mono text-xs">{{ value }}</span>
        </template>
        <template #cell-estimated_seconds="{ row }">
          <span class="whitespace-nowrap text-sm">{{ formatSeconds(row.estimated_seconds) }}</span>
          <span v-if="typeof row.audio_bytes === 'number'" class="ml-1 whitespace-nowrap text-xs text-gray-400">
            {{ formatBytes(row.audio_bytes) }}
          </span>
        </template>
        <template #cell-duration_ms="{ value }">
          <span class="whitespace-nowrap text-sm">{{ typeof value === 'number' ? formatSeconds(value / 1000) : '--' }}</span>
        </template>
        <template #cell-cost_usd="{ row }">
          <span v-if="row.billed === false" class="whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexVoice.sessions.notBilled') }}
          </span>
          <span v-else class="whitespace-nowrap text-sm">
            {{ typeof row.cost_usd === 'number' ? formatCurrency(row.cost_usd) : '--' }}
          </span>
        </template>
        <template #cell-end_reason="{ value }">
          <span class="whitespace-nowrap text-sm">{{ endReason(value) }}</span>
        </template>
        <template #empty>
          <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-voice-sessions-empty">
            {{ t('admin.claudexVoice.sessions.empty') }}
          </p>
        </template>
      </DataTable>

      <Pagination
        v-if="total > 0"
        :total="total"
        :page="page"
        :page-size="pageSize"
        :show-page-size-selector="false"
        @update:page="changePage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DataTable from '@/components/common/DataTable.vue'
import Pagination from '@/components/common/Pagination.vue'
import type { Column } from '@/components/common/types'
import { claudexErrorMessage } from '../common/errors'
import { toInteger } from '../general/pageSupport'
import { listVoiceSessions, type VoiceSession } from '@/api/admin/claudex/voice'
import { formatBytes, formatCurrency, formatDateTime } from '@/utils/format'

const PAGE_SIZE = 20

const { t, te } = useI18n()

const items = ref<VoiceSession[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = PAGE_SIZE
const loading = ref(false)
const error = ref<string | null>(null)
const userIdInput = ref<number | string>('')
const userId = ref<number | undefined>(undefined)

const columns = computed<Column[]>(() => [
  { key: 'created_at', label: t('admin.claudexVoice.sessions.columns.time') },
  { key: 'user', label: t('admin.claudexVoice.sessions.columns.user') },
  { key: 'request_id', label: t('admin.claudexVoice.sessions.columns.requestId') },
  { key: 'estimated_seconds', label: t('admin.claudexVoice.sessions.columns.audio') },
  { key: 'duration_ms', label: t('admin.claudexVoice.sessions.columns.duration') },
  { key: 'cost_usd', label: t('admin.claudexVoice.sessions.columns.cost') },
  { key: 'end_reason', label: t('admin.claudexVoice.sessions.columns.ended') }
])

function formatSeconds(value: unknown): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return '--'
  const whole = Math.ceil(n)
  const minutes = Math.floor(whole / 60)
  const seconds = whole % 60
  return minutes > 0
    ? t('admin.claudexVoice.sessions.minutesSeconds', { minutes, seconds })
    : t('admin.claudexVoice.sessions.seconds', { seconds })
}

/** Known end reasons have a label; anything newer is shown as the server sent it. */
function endReason(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '--'
  const key = `admin.claudexVoice.sessions.endReasons.${value}`
  return te(key) ? t(key) : value
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const result = await listVoiceSessions({ user_id: userId.value, page: page.value, page_size: pageSize })
    items.value = result.items ?? []
    total.value = result.total ?? 0
  } catch (err) {
    items.value = []
    total.value = 0
    error.value = claudexErrorMessage(err, t, te, 'claudexVoice', t('admin.claudexVoice.sessions.loadFailed'))
  } finally {
    loading.value = false
  }
}

function applyFilter() {
  const id = toInteger(userIdInput.value)
  userId.value = id !== null && id > 0 ? id : undefined
  if (userId.value === undefined) userIdInput.value = ''
  page.value = 1
  void load()
}

function clearFilter() {
  userIdInput.value = ''
  userId.value = undefined
  page.value = 1
  void load()
}

function changePage(next: number) {
  page.value = next
  void load()
}

onMounted(load)

defineExpose({ reload: load })
</script>
