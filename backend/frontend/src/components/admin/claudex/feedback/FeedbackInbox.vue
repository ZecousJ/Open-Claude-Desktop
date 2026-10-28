<!--
  CLAUDEX: reply feedback (thumbs up/down) sent from the desktop app (design
  2.9): filters, a paged list, a details drawer with the comment and, when the
  user included it and excerpts are allowed, the conversation excerpt
  (opening it is audited by the server), and delete.
-->
<template>
  <div class="space-y-4" data-testid="claudex-feedback-inbox">
    <form class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="claudex-feedback-filters" @submit.prevent="applyFilters">
      <div>
        <label for="claudex-fb-rating" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.rating') }}</label>
        <select id="claudex-fb-rating" v-model="filters.rating" class="input w-full" data-testid="claudex-fb-filter-rating">
          <option value="">{{ t('admin.claudexFeedback.filters.anyRating') }}</option>
          <option value="up">{{ t('admin.claudexFeedback.ratings.up') }}</option>
          <option value="down">{{ t('admin.claudexFeedback.ratings.down') }}</option>
        </select>
      </div>
      <div>
        <label for="claudex-fb-user" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.userId') }}</label>
        <input
          id="claudex-fb-user"
          v-model="filters.userId"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          class="input w-full"
          :placeholder="t('admin.claudexFeedback.filters.any')"
          data-testid="claudex-fb-filter-user"
        />
      </div>
      <div>
        <label for="claudex-fb-from" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.from') }}</label>
        <input id="claudex-fb-from" v-model="filters.from" type="date" class="input w-full" data-testid="claudex-fb-filter-from" />
      </div>
      <div>
        <label for="claudex-fb-to" class="input-label mb-1.5 block">{{ t('admin.claudexFeedback.filters.to') }}</label>
        <input id="claudex-fb-to" v-model="filters.to" type="date" class="input w-full" data-testid="claudex-fb-filter-to" />
      </div>
      <div class="flex gap-2 sm:col-span-2 lg:col-span-4">
        <button type="submit" class="btn btn-secondary" :disabled="loading" data-testid="claudex-fb-apply">
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
      data-testid="claudex-feedback-error"
    >
      {{ error }}
    </p>

    <DataTable :columns="columns" :data="items" :loading="loading" row-key="id" clickable-rows @row-click="openDetail">
      <template #cell-created_at="{ value }">
        <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
      </template>
      <template #cell-user="{ row }">
        <span class="text-sm">{{ row.user_email || `#${row.user_id}` }}</span>
      </template>
      <template #cell-rating="{ value }">
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
          :class="
            value === 'up'
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
          "
        >
          {{ ratingLabel(value) }}
        </span>
      </template>
      <template #cell-categories="{ value }">
        <span class="text-xs text-gray-600 dark:text-gray-300">{{ Array.isArray(value) && value.length ? value.join(', ') : '--' }}</span>
      </template>
      <template #cell-comment="{ value }">
        <span class="block max-w-xs truncate text-sm" :title="value || ''">{{ value || '--' }}</span>
      </template>
      <template #cell-model="{ value }">
        <span class="font-mono text-xs">{{ value || '--' }}</span>
      </template>
      <template #cell-actions="{ row }">
        <div class="flex items-center gap-1">
          <button type="button" class="btn btn-ghost btn-sm" :data-testid="`claudex-fb-view-${row.id}`" @click.stop="openDetail(row)">
            {{ t('admin.claudexFeedback.actions.view') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm text-red-600 dark:text-red-400"
            :data-testid="`claudex-fb-delete-${row.id}`"
            @click.stop="askDelete(row)"
          >
            {{ t('admin.claudexFeedback.actions.delete') }}
          </button>
        </div>
      </template>
      <template #empty>
        <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-feedback-empty">
          {{ t('admin.claudexFeedback.feedback.empty') }}
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
      :title="t('admin.claudexFeedback.feedback.detailTitle')"
      :loading="detailLoading"
      :error="detailError"
      @close="closeDetail"
    >
      <dl v-if="detail" class="space-y-4 text-sm" data-testid="claudex-feedback-detail">
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
        <div>
          <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexFeedback.fields.comment') }}</dt>
          <dd
            class="mt-1 whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-gray-900 dark:bg-dark-900/40 dark:text-gray-100"
            data-testid="claudex-feedback-detail-comment"
          >
            {{ detail.comment || t('admin.claudexFeedback.feedback.noComment') }}
          </dd>
        </div>
        <div>
          <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexFeedback.fields.excerpt') }}</dt>
          <dd
            v-if="detail.conversation_excerpt"
            class="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-900 dark:bg-dark-900/40 dark:text-gray-100"
            data-testid="claudex-feedback-detail-excerpt"
          >
            {{ detail.conversation_excerpt }}
          </dd>
          <dd v-else class="mt-1 text-gray-500 dark:text-gray-400" data-testid="claudex-feedback-detail-no-excerpt">
            {{ t('admin.claudexFeedback.feedback.noExcerpt') }}
          </dd>
        </div>
      </dl>
      <template v-if="detail" #footer>
        <button type="button" class="btn btn-danger" data-testid="claudex-feedback-detail-delete" @click="askDelete(detail)">
          {{ t('admin.claudexFeedback.actions.delete') }}
        </button>
      </template>
    </DetailDrawer>

    <ConfirmDialog
      :show="pendingDelete !== null"
      :title="t('admin.claudexFeedback.feedback.deleteTitle')"
      :message="t('admin.claudexFeedback.feedback.deleteMessage')"
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
  deleteFeedback,
  getFeedback,
  listFeedback,
  type FeedbackEntry,
  type FeedbackQuery
} from '@/api/admin/claudex/feedback'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/format'

const PAGE_SIZE = 20

const { t, te } = useI18n()
const appStore = useAppStore()

const filters = reactive({ rating: '' as '' | 'up' | 'down', userId: '' as number | string, from: '', to: '' })
const applied = ref<FeedbackQuery>({})
const items = ref<FeedbackEntry[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref<string | null>(null)

const drawerOpen = ref(false)
const detail = ref<FeedbackEntry | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const pendingDelete = ref<FeedbackEntry | null>(null)

const columns = computed<Column[]>(() => [
  { key: 'created_at', label: t('admin.claudexFeedback.fields.receivedAt') },
  { key: 'user', label: t('admin.claudexFeedback.fields.user') },
  { key: 'rating', label: t('admin.claudexFeedback.fields.rating') },
  { key: 'categories', label: t('admin.claudexFeedback.fields.categories') },
  { key: 'comment', label: t('admin.claudexFeedback.fields.comment') },
  { key: 'model', label: t('admin.claudexFeedback.fields.model') },
  { key: 'actions', label: t('admin.claudexFeedback.fields.actions') }
])

function ratingLabel(rating: string): string {
  return rating === 'up' ? t('admin.claudexFeedback.ratings.up') : t('admin.claudexFeedback.ratings.down')
}

const detailFields = computed(() => {
  const d = detail.value
  if (!d) return []
  return [
    { label: t('admin.claudexFeedback.fields.receivedAt'), value: formatDateTime(d.created_at) },
    { label: t('admin.claudexFeedback.fields.user'), value: d.user_email ? `${d.user_email} (#${d.user_id})` : `#${d.user_id}` },
    { label: t('admin.claudexFeedback.fields.rating'), value: ratingLabel(d.rating) },
    { label: t('admin.claudexFeedback.fields.categories'), value: (d.categories ?? []).join(', ') },
    { label: t('admin.claudexFeedback.fields.model'), value: d.model, mono: true },
    { label: t('admin.claudexFeedback.fields.appVersion'), value: d.app_version, mono: true },
    { label: t('admin.claudexFeedback.fields.platform'), value: d.platform },
    { label: t('admin.claudexFeedback.fields.feedbackId'), value: d.feedback_uuid, mono: true }
  ]
})

function buildQuery(): FeedbackQuery {
  const query: FeedbackQuery = {}
  if (filters.rating) query.rating = filters.rating
  const userId = toInteger(filters.userId)
  if (userId !== null && userId > 0) query.user_id = userId
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
    const result = await listFeedback({ ...applied.value, page: page.value, page_size: PAGE_SIZE })
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
  Object.assign(filters, { rating: '', userId: '', from: '', to: '' })
  applyFilters()
}

function changePage(next: number) {
  page.value = next
  void load()
}

async function openDetail(row: FeedbackEntry) {
  drawerOpen.value = true
  detail.value = null
  detailError.value = null
  detailLoading.value = true
  try {
    detail.value = await getFeedback(row.id)
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

function askDelete(row: FeedbackEntry) {
  pendingDelete.value = row
}

async function confirmDelete() {
  const row = pendingDelete.value
  pendingDelete.value = null
  if (!row) return
  try {
    await deleteFeedback(row.id)
    appStore.showSuccess(t('admin.claudexFeedback.feedback.deleted'))
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
