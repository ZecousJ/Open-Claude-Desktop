<!--
  CLAUDEX: diagnostic reports sent by the desktop app (design 2.9): filters,
  a paged list, a details drawer (opening it is audited by the server) and
  delete.
-->
<template>
  <div class="space-y-4" data-testid="claudex-diagnostics-inbox">
    <form class="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" data-testid="claudex-diagnostics-filters" @submit.prevent="applyFilters">
      <div>
        <label for="claudex-diag-user" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.userId') }}</label>
        <input
          id="claudex-diag-user"
          v-model="filters.userId"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          class="input w-full"
          :placeholder="t('admin.claudexFeedback.filters.any')"
          data-testid="claudex-diag-filter-user"
        />
      </div>
      <div>
        <label for="claudex-diag-kind" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.kind') }}</label>
        <select id="claudex-diag-kind" v-model="filters.kind" class="input w-full" data-testid="claudex-diag-filter-kind">
          <option value="">{{ t('admin.claudexFeedback.filters.anyKind') }}</option>
          <option v-for="kind in DIAGNOSTIC_KINDS" :key="kind" :value="kind">{{ kindLabel(kind) }}</option>
        </select>
      </div>
      <div>
        <label for="claudex-diag-code" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.code') }}</label>
        <input
          id="claudex-diag-code"
          v-model="filters.code"
          type="text"
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
          class="input w-full font-mono"
          data-testid="claudex-diag-filter-code"
        />
      </div>
      <div>
        <label for="claudex-diag-version" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.appVersion') }}</label>
        <input
          id="claudex-diag-version"
          v-model="filters.appVersion"
          type="text"
          maxlength="32"
          autocomplete="off"
          spellcheck="false"
          class="input w-full font-mono"
          data-testid="claudex-diag-filter-version"
        />
      </div>
      <div>
        <label for="claudex-diag-from" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.from') }}</label>
        <input id="claudex-diag-from" v-model="filters.from" type="date" class="input w-full" data-testid="claudex-diag-filter-from" />
      </div>
      <div>
        <label for="claudex-diag-to" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.to') }}</label>
        <input id="claudex-diag-to" v-model="filters.to" type="date" class="input w-full" data-testid="claudex-diag-filter-to" />
      </div>
      <div class="flex gap-2 sm:col-span-2 lg:col-span-6">
        <button type="submit" class="btn btn-secondary" :disabled="loading" data-testid="claudex-diag-apply">
          {{ t('admin.claudexFeedback.filters.apply') }}
        </button>
        <button type="button" class="btn btn-ghost" :disabled="loading" @click="resetFilters">
          {{ t('admin.claudexFeedback.filters.reset') }}
        </button>
      </div>
    </form>

    <p
      v-if="error"
      role="alert"
      class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
      data-testid="claudex-diagnostics-error"
    >
      {{ error }}
    </p>

    <DataTable :columns="columns" :data="items" :loading="loading" row-key="id" clickable-rows @row-click="openDetail">
      <template #cell-occurred_at="{ value }">
        <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
      </template>
      <template #cell-user="{ row }">
        <span class="text-sm">{{ row.user_email || `#${row.user_id}` }}</span>
      </template>
      <template #cell-kind="{ value }">
        <span class="text-sm">{{ kindLabel(value) }}</span>
      </template>
      <template #cell-code="{ value }">
        <span class="font-mono text-xs">{{ value || '--' }}</span>
      </template>
      <template #cell-message="{ value }">
        <span class="block max-w-xs truncate text-sm" :title="value">{{ value || '--' }}</span>
      </template>
      <template #cell-app_version="{ row }">
        <span class="whitespace-nowrap font-mono text-xs">{{ row.app_version || '--' }}</span>
        <span v-if="row.platform" class="ml-1 text-xs text-gray-400">{{ row.platform }}{{ row.arch ? `/${row.arch}` : '' }}</span>
      </template>
      <template #cell-actions="{ row }">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :data-testid="`claudex-diag-view-${row.id}`"
            @click.stop="openDetail(row)"
          >
            {{ t('admin.claudexFeedback.actions.view') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm text-red-600 dark:text-red-400"
            :data-testid="`claudex-diag-delete-${row.id}`"
            @click.stop="askDelete(row)"
          >
            {{ t('admin.claudexFeedback.actions.delete') }}
          </button>
        </div>
      </template>
      <template #empty>
        <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-diagnostics-empty">
          {{ t('admin.claudexFeedback.diagnostics.empty') }}
        </p>
      </template>
    </DataTable>

    <Pagination
      v-if="total > 0"
      :total="total"
      :page="page"
      :page-size="PAGE_SIZE"
      :show-page-size-selector="false"
      @update:page="changePage"
    />

    <DetailDrawer
      :show="drawerOpen"
      :title="t('admin.claudexFeedback.diagnostics.detailTitle')"
      :loading="detailLoading"
      :error="detailError"
      @close="closeDetail"
    >
      <dl v-if="detail" class="space-y-4 text-sm" data-testid="claudex-diagnostic-detail">
        <div v-for="field in detailFields" :key="field.label" class="grid grid-cols-3 gap-3">
          <dt class="text-gray-500 dark:text-gray-400">{{ field.label }}</dt>
          <dd class="col-span-2 min-w-0 break-words text-gray-900 dark:text-gray-100" :class="{ 'font-mono text-xs': field.mono }">
            {{ field.value || '--' }}
          </dd>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexFeedback.fields.requestId') }}</dt>
          <dd class="col-span-2 min-w-0"><RequestIdLink :request-id="detail.request_id" /></dd>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexFeedback.fields.context') }}</dt>
          <dd class="col-span-2 min-w-0">
            <ul v-if="contextEntries.length" class="space-y-1" data-testid="claudex-diagnostic-context">
              <li v-for="[key, value] in contextEntries" :key="key" class="break-words font-mono text-xs">
                <span class="text-gray-500 dark:text-gray-400">{{ key }}:</span> {{ value }}
              </li>
            </ul>
            <span v-else class="text-gray-400">--</span>
          </dd>
        </div>
      </dl>
      <template v-if="detail" #footer>
        <button type="button" class="btn btn-danger" data-testid="claudex-diagnostic-detail-delete" @click="askDelete(detail)">
          {{ t('admin.claudexFeedback.actions.delete') }}
        </button>
      </template>
    </DetailDrawer>

    <ConfirmDialog
      :show="pendingDelete !== null"
      :title="t('admin.claudexFeedback.diagnostics.deleteTitle')"
      :message="t('admin.claudexFeedback.diagnostics.deleteMessage')"
      :confirm-text="t('admin.claudexFeedback.actions.delete')"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import DataTable from '@/components/common/DataTable.vue'
import Pagination from '@/components/common/Pagination.vue'
import type { Column } from '@/components/common/types'
import { claudexErrorMessage, claudexErrorReason } from '../common/errors'
import { dayBoundary, toInteger } from '../general/pageSupport'
import DetailDrawer from './DetailDrawer.vue'
import RequestIdLink from './RequestIdLink.vue'
import {
  DIAGNOSTIC_KINDS,
  deleteDiagnostic,
  getDiagnostic,
  listDiagnostics,
  type DiagnosticReport,
  type DiagnosticsQuery
} from '@/api/admin/claudex/feedback'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/format'

const PAGE_SIZE = 20

const { t, te } = useI18n()
const appStore = useAppStore()

const filters = reactive({ userId: '' as number | string, kind: '', code: '', appVersion: '', from: '', to: '' })
const applied = ref<DiagnosticsQuery>({})
const items = ref<DiagnosticReport[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref<string | null>(null)

const drawerOpen = ref(false)
const detail = ref<DiagnosticReport | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const pendingDelete = ref<DiagnosticReport | null>(null)

const columns = computed<Column[]>(() => [
  { key: 'occurred_at', label: t('admin.claudexFeedback.fields.occurredAt') },
  { key: 'user', label: t('admin.claudexFeedback.fields.user') },
  { key: 'kind', label: t('admin.claudexFeedback.fields.kind') },
  { key: 'code', label: t('admin.claudexFeedback.fields.code') },
  { key: 'message', label: t('admin.claudexFeedback.fields.message') },
  { key: 'app_version', label: t('admin.claudexFeedback.fields.appVersion') },
  { key: 'actions', label: t('admin.claudexFeedback.fields.actions') }
])

function kindLabel(kind: string): string {
  const key = `admin.claudexFeedback.kinds.${kind}`
  return te(key) ? t(key) : kind
}

const detailFields = computed(() => {
  const d = detail.value
  if (!d) return []
  return [
    { label: t('admin.claudexFeedback.fields.occurredAt'), value: formatDateTime(d.occurred_at) },
    { label: t('admin.claudexFeedback.fields.receivedAt'), value: formatDateTime(d.created_at) },
    { label: t('admin.claudexFeedback.fields.user'), value: d.user_email ? `${d.user_email} (#${d.user_id})` : `#${d.user_id}` },
    { label: t('admin.claudexFeedback.fields.kind'), value: kindLabel(d.kind) },
    { label: t('admin.claudexFeedback.fields.code'), value: d.code, mono: true },
    { label: t('admin.claudexFeedback.fields.message'), value: d.message },
    { label: t('admin.claudexFeedback.fields.model'), value: d.model, mono: true },
    { label: t('admin.claudexFeedback.fields.appVersion'), value: d.app_version, mono: true },
    { label: t('admin.claudexFeedback.fields.codexVersion'), value: d.codex_version, mono: true },
    {
      label: t('admin.claudexFeedback.fields.platform'),
      value: [d.platform, d.arch].filter(Boolean).join(' / ')
    },
    { label: t('admin.claudexFeedback.fields.osVersion'), value: d.os_version },
    { label: t('admin.claudexFeedback.fields.reportId'), value: d.report_uuid, mono: true }
  ]
})

const contextEntries = computed<Array<[string, string]>>(() => {
  const context = detail.value?.context
  if (!context || typeof context !== 'object') return []
  return Object.entries(context).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
})

function buildQuery(): DiagnosticsQuery {
  const query: DiagnosticsQuery = {}
  const userId = toInteger(filters.userId)
  if (userId !== null && userId > 0) query.user_id = userId
  if (filters.kind) query.kind = filters.kind
  if (filters.code.trim()) query.code = filters.code.trim()
  if (filters.appVersion.trim()) query.app_version = filters.appVersion.trim()
  const from = dayBoundary(filters.from, 'start')
  const to = dayBoundary(filters.to, 'end')
  if (from) query.from = from
  if (to) query.to = to
  return query
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const result = await listDiagnostics({ ...applied.value, page: page.value, page_size: PAGE_SIZE })
    items.value = result.items ?? []
    total.value = result.total ?? 0
  } catch (err) {
    items.value = []
    total.value = 0
    error.value = claudexErrorMessage(err, t, te, 'claudexFeedback', t('admin.claudexFeedback.loadListFailed'))
  } finally {
    loading.value = false
  }
}

function applyFilters() {
  applied.value = buildQuery()
  page.value = 1
  void load()
}

function resetFilters() {
  Object.assign(filters, { userId: '', kind: '', code: '', appVersion: '', from: '', to: '' })
  applyFilters()
}

function changePage(next: number) {
  page.value = next
  void load()
}

async function openDetail(row: DiagnosticReport) {
  drawerOpen.value = true
  detail.value = null
  detailError.value = null
  detailLoading.value = true
  try {
    detail.value = await getDiagnostic(row.id)
  } catch (err) {
    detailError.value = claudexErrorMessage(err, t, te, 'claudexFeedback', t('admin.claudexFeedback.loadDetailFailed'))
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  drawerOpen.value = false
  detail.value = null
  detailError.value = null
}

function askDelete(row: DiagnosticReport) {
  pendingDelete.value = row
}

async function confirmDelete() {
  const row = pendingDelete.value
  pendingDelete.value = null
  if (!row) return
  try {
    await deleteDiagnostic(row.id)
    appStore.showSuccess(t('admin.claudexFeedback.diagnostics.deleted'))
    if (detail.value?.id === row.id) closeDetail()
    if (items.value.length === 1 && page.value > 1) page.value -= 1
    await load()
  } catch (err) {
    appStore.showError(claudexErrorMessage(err, t, te, 'claudexFeedback', t('admin.claudexFeedback.deleteFailed')))
    // Already gone (for example deleted by another admin): drop the stale row.
    if (claudexErrorReason(err) === 'CLAUDEX_REPORT_NOT_FOUND') {
      if (detail.value?.id === row.id) closeDetail()
      await load()
    }
  }
}

onMounted(load)

defineExpose({ reload: load })
</script>
