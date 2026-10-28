<!--
  CLAUDEX: /admin/claudex/models — the model catalog (K2, design §2.4 / §3.2).
  Each entry sets how one model looks in the Claudex desktop app, either for
  every group (global) or for one group, whose entry replaces the global one.
  Which models a user can use still comes from the gateway: the app only lists
  models its device key's /v1/models returns. Every write goes through step-up
  (R13); Fast mode was dropped (R6), so there is no Fast column.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexModels.title')"
    :description="t('admin.claudexModels.description')"
    :load-error="loadError"
    test-id="claudex-models-page"
    @retry="loadRows"
  >
    <template #actions>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="loading"
        :title="t('admin.claudexModels.refresh')"
        :aria-label="t('admin.claudexModels.refresh')"
        data-testid="claudex-models-refresh"
        @click="refresh"
      >
        <Icon name="refresh" size="md" :class="loading ? 'animate-spin' : ''" />
      </button>
      <button type="button" class="btn btn-primary" data-testid="claudex-models-add" @click="openCreate">
        <Icon name="plus" size="md" class="mr-1" />
        {{ t('admin.claudexModels.add') }}
      </button>
    </template>

    <div
      class="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800/50 dark:bg-blue-900/20 dark:text-blue-200"
      data-testid="claudex-models-note"
    >
      <Icon name="infoCircle" size="md" class="mt-0.5 flex-shrink-0" />
      <div class="space-y-1">
        <p>{{ t('admin.claudexModels.availabilityNote') }}</p>
        <p>{{ t('admin.claudexModels.hiddenNote') }}</p>
      </div>
    </div>

    <GroupPlacementsPanel ref="groupPanel" :step-up="stepUp" />

    <div class="card overflow-hidden">
      <div class="border-b border-gray-100 px-4 pt-4 dark:border-dark-700">
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">
          {{ t('admin.claudexModels.descriptionsTitle') }}
        </h3>
        <p class="mt-0.5 text-sm text-gray-500 dark:text-dark-400">{{ t('admin.claudexModels.descriptionsHint') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3 border-b border-gray-100 p-4 dark:border-dark-700">
        <div class="w-full sm:w-56">
          <Select
            v-model="scopeFilter"
            :options="scopeFilterOptions"
            :aria-label="t('admin.claudexModels.scopeFilter')"
            data-testid="claudex-models-scope-filter"
            @change="onScopeChange"
          />
        </div>
        <div class="w-full sm:max-w-64 sm:flex-1">
          <input
            v-model="search"
            type="search"
            class="input"
            :placeholder="t('admin.claudexModels.searchPlaceholder')"
            :aria-label="t('admin.claudexModels.searchPlaceholder')"
            data-testid="claudex-models-search"
            @input="onSearchInput"
          />
        </div>
      </div>

      <DataTable :columns="columns" :data="rows" :loading="loading" row-key="id" data-testid="claudex-models-table">
        <template #cell-model_id="{ row }">
          <div class="min-w-0 max-w-xs">
            <div class="truncate font-mono text-sm text-gray-900 dark:text-white" :title="row.model_id">
              {{ row.model_id }}
            </div>
            <div
              v-if="row.description"
              class="mt-0.5 truncate text-xs text-gray-500 dark:text-dark-400"
              :title="row.description"
            >
              {{ row.description }}
            </div>
          </div>
        </template>

        <template #cell-scope="{ row }">
          <span v-if="row.group_id === null" class="badge badge-gray" data-testid="claudex-models-scope-global">
            {{ t('admin.claudexModels.scopeGlobal') }}
          </span>
          <span v-else class="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            {{ rowGroupName(row) }}
            <span
              v-if="row.group_deleted"
              class="badge badge-warning"
              :title="t('admin.claudexModels.groupDeletedHint')"
              data-testid="claudex-models-group-deleted"
            >
              {{ t('admin.claudexModels.groupDeletedBadge') }}
            </span>
          </span>
        </template>

        <template #cell-display_name="{ row }">
          <span class="text-sm text-gray-900 dark:text-white">{{ row.display_name || '—' }}</span>
        </template>

        <template #cell-badges="{ row }">
          <div v-if="row.badges?.length" class="flex flex-wrap gap-1">
            <span
              v-for="badge in row.badges"
              :key="badge"
              class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-dark-700 dark:text-gray-200"
            >
              {{ badge }}
            </span>
          </div>
          <span v-else class="text-gray-400">—</span>
        </template>

        <template #cell-sort_order="{ row }">
          <span class="text-sm tabular-nums text-gray-700 dark:text-gray-300">{{ row.sort_order }}</span>
        </template>

        <template #cell-hidden="{ row }">
          <span
            v-if="row.hidden"
            class="badge badge-gray"
            :title="t('admin.claudexModels.editor.hiddenHint')"
            data-testid="claudex-models-hidden"
          >
            {{ t('admin.claudexModels.hiddenYes') }}
          </span>
          <span v-else class="text-gray-400">—</span>
        </template>

        <template #cell-is_default="{ row }">
          <span v-if="row.is_default" class="badge badge-success" data-testid="claudex-models-default">
            {{ t('admin.claudexModels.defaultYes') }}
          </span>
          <span v-else class="text-gray-400">—</span>
        </template>

        <template #cell-supported_efforts="{ row }">
          <span v-if="!row.supported_efforts" class="text-sm text-gray-400">
            {{ t('admin.claudexModels.effortsUnknown') }}
          </span>
          <div v-else class="flex flex-wrap gap-1">
            <span
              v-for="effort in row.supported_efforts"
              :key="effort"
              class="rounded px-1.5 py-0.5 font-mono text-xs"
              :class="
                effort === row.default_effort
                  ? 'bg-primary-100 text-primary-800 dark:bg-primary-900/40 dark:text-primary-200'
                  : 'bg-gray-100 text-gray-700 dark:bg-dark-700 dark:text-gray-200'
              "
              :title="effort === row.default_effort ? t('admin.claudexModels.defaultEffortMark') : undefined"
            >
              {{ effort }}
            </span>
          </div>
        </template>

        <template #cell-context_window="{ row }">
          <span class="text-sm tabular-nums text-gray-700 dark:text-gray-300">{{
            formatTokens(row.context_window)
          }}</span>
        </template>

        <template #cell-auto_compact_tokens="{ row }">
          <span class="text-sm tabular-nums text-gray-700 dark:text-gray-300">
            {{ formatTokens(row.auto_compact_tokens) }}
          </span>
        </template>

        <template #cell-usage_hint="{ row }">
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ row.usage_hint || '—' }}</span>
        </template>

        <template #cell-actions="{ row }">
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-600 dark:hover:text-gray-300"
              :title="t('admin.claudexModels.actions.edit')"
              :aria-label="t('admin.claudexModels.actions.edit')"
              data-testid="claudex-models-edit"
              @click="openEdit(row)"
            >
              <Icon name="edit" size="sm" />
            </button>
            <button
              v-if="!row.is_default"
              type="button"
              class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-50 dark:hover:bg-emerald-900/20 dark:hover:text-emerald-400"
              :title="t('admin.claudexModels.actions.makeDefault')"
              :aria-label="t('admin.claudexModels.actions.makeDefault')"
              :disabled="busyRowId !== null"
              data-testid="claudex-models-make-default"
              @click="makeDefault(row)"
            >
              <Icon name="checkCircle" size="sm" />
            </button>
            <button
              type="button"
              class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              :title="t('admin.claudexModels.actions.delete')"
              :aria-label="t('admin.claudexModels.actions.delete')"
              :disabled="busyRowId !== null"
              data-testid="claudex-models-delete"
              @click="askDelete(row)"
            >
              <Icon name="trash" size="sm" />
            </button>
          </div>
        </template>

        <template #empty>
          <EmptyState
            :title="t('admin.claudexModels.emptyTitle')"
            :description="t('admin.claudexModels.emptyDescription')"
            :action-text="t('admin.claudexModels.add')"
            @action="openCreate"
          />
        </template>
      </DataTable>
    </div>

    <Pagination
      v-if="pagination.total > 0"
      :page="pagination.page"
      :total="pagination.total"
      :page-size="pagination.page_size"
      @update:page="onPageChange"
      @update:pageSize="onPageSizeChange"
    />

    <ModelMetaEditorDialog
      :show="editorOpen"
      :row="editingRow"
      :groups="groups"
      :default-group-id="typeof scopeFilter === 'number' ? scopeFilter : null"
      :step-up="stepUp"
      @close="closeEditor"
      @saved="onSaved"
      @stale="onStale"
    />

    <ConfirmDialog
      :show="deletingRow !== null"
      :title="t('admin.claudexModels.deleteTitle')"
      :message="deleteMessage"
      :confirm-text="t('admin.claudexModels.actions.delete')"
      danger
      @confirm="confirmDelete"
      @cancel="deletingRow = null"
    />
    <TotpStepUpDialog :controller="stepUp" />
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import { claudexErrorMessage, claudexErrorReason } from '@/components/admin/claudex/common/errors'
import GroupPlacementsPanel from '@/components/admin/claudex/models/GroupPlacementsPanel.vue'
import ModelMetaEditorDialog from '@/components/admin/claudex/models/ModelMetaEditorDialog.vue'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import DataTable from '@/components/common/DataTable.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Pagination from '@/components/common/Pagination.vue'
import Select from '@/components/common/Select.vue'
import Icon from '@/components/icons/Icon.vue'
import type { Column } from '@/components/common/types'
import { adminAPI } from '@/api/admin'
import { inputFromRow, type ClaudexModelMeta, type ClaudexModelScopeFilter } from '@/api/admin/claudex/models'
import { getPersistedPageSize } from '@/composables/usePersistedPageSize'
import { isStepUpCancelled, useStepUp } from '@/composables/useStepUp'
import { useAppStore } from '@/stores/app'
import type { AdminGroup } from '@/types'

const { t, te } = useI18n()
const appStore = useAppStore()
const stepUp = useStepUp()
const groupPanel = ref<{ load: () => Promise<void> } | null>(null)

const rows = ref<ClaudexModelMeta[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const groups = ref<AdminGroup[]>([])
const scopeFilter = ref<ClaudexModelScopeFilter>('all')
const search = ref('')
const pagination = reactive({ page: 1, page_size: getPersistedPageSize(), total: 0 })

const columns = computed<Column[]>(() => [
  { key: 'model_id', label: t('admin.claudexModels.columns.model') },
  { key: 'scope', label: t('admin.claudexModels.columns.scope') },
  { key: 'display_name', label: t('admin.claudexModels.columns.displayName') },
  { key: 'badges', label: t('admin.claudexModels.columns.badges') },
  { key: 'sort_order', label: t('admin.claudexModels.columns.sort') },
  { key: 'hidden', label: t('admin.claudexModels.columns.hidden') },
  { key: 'is_default', label: t('admin.claudexModels.columns.default') },
  { key: 'supported_efforts', label: t('admin.claudexModels.columns.efforts') },
  { key: 'context_window', label: t('admin.claudexModels.columns.contextWindow') },
  { key: 'auto_compact_tokens', label: t('admin.claudexModels.columns.autoCompact') },
  { key: 'usage_hint', label: t('admin.claudexModels.columns.usageHint') },
  { key: 'actions', label: t('admin.claudexModels.columns.actions') }
])

const scopeFilterOptions = computed(() => [
  { value: 'all', label: t('admin.claudexModels.scopeAll') },
  { value: 'global', label: t('admin.claudexModels.scopeGlobal') },
  ...groups.value.map((group) => ({
    value: group.id,
    label: group.status === 'active' ? group.name : t('admin.claudexModels.groupInactive', { name: group.name })
  }))
])

const groupNames = computed(() => new Map(groups.value.map((group) => [group.id, group.name])))

/** The name of a row's scope: from the group list, else the name the row carries, else the id. */
function rowGroupName(row: ClaudexModelMeta): string {
  if (row.group_id === null) return t('admin.claudexModels.scopeGlobal')
  return (
    groupNames.value.get(row.group_id) ??
    (row.group_name || t('admin.claudexModels.groupFallback', { id: row.group_id }))
  )
}

const numberFormat = new Intl.NumberFormat()

function formatTokens(value: number | null | undefined): string {
  return typeof value === 'number' ? numberFormat.format(value) : '—'
}

function errorText(err: unknown, fallbackKey: string): string {
  return claudexErrorMessage(err, t, te, 'claudexModels', t(fallbackKey))
}

// ----- Loading -----
let listController: AbortController | null = null

async function loadRows() {
  listController?.abort()
  const controller = new AbortController()
  listController = controller
  loading.value = true
  let pastTheEnd = false
  try {
    const result = await adminAPI.claudex.models.list(
      {
        scope: scopeFilter.value,
        q: search.value,
        page: pagination.page,
        page_size: pagination.page_size
      },
      { signal: controller.signal }
    )
    if (listController !== controller) return
    rows.value = Array.isArray(result?.items) ? result.items : []
    pagination.total = result?.total ?? rows.value.length
    pagination.page = result?.page || pagination.page
    // The server serves at most 200 rows a page; page with the size it used so no row is out of reach.
    if (typeof result?.page_size === 'number' && result.page_size > 0 && result.page_size < pagination.page_size) {
      pagination.page_size = result.page_size
    }
    loadError.value = null
    // A page past the end (e.g. after deleting its last entry) shows the last page instead.
    const pages = Math.max(1, Math.ceil(pagination.total / pagination.page_size))
    if (rows.value.length === 0 && pagination.total > 0 && pagination.page > pages) {
      pagination.page = pages
      pastTheEnd = true
    }
  } catch (err) {
    if (listController !== controller || isCancel(err)) return
    loadError.value = errorText(err, 'admin.claudexModels.loadFailed')
  } finally {
    if (listController === controller) {
      loading.value = false
      listController = null
    }
  }
  if (pastTheEnd) await loadRows()
}

function isCancel(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null
  return e?.name === 'AbortError' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED'
}

const groupsFailed = ref(false)

async function loadGroups() {
  try {
    groups.value = (await adminAPI.groups.getAllIncludingInactive()) ?? []
    groupsFailed.value = false
  } catch {
    groupsFailed.value = true
    appStore.showError(t('admin.claudexModels.groupsLoadFailed'))
  }
}

function refresh() {
  if (groupsFailed.value) void loadGroups()
  void loadRows()
  void groupPanel.value?.load()
}

function onScopeChange() {
  pagination.page = 1
  void loadRows()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    pagination.page = 1
    void loadRows()
  }, 300)
}

function onPageChange(page: number) {
  pagination.page = page
  void loadRows()
}

function onPageSizeChange(size: number) {
  pagination.page_size = size
  pagination.page = 1
  void loadRows()
}

// ----- Editor -----
const editorOpen = ref(false)
const editingRow = ref<ClaudexModelMeta | null>(null)

function openCreate() {
  editingRow.value = null
  editorOpen.value = true
}

function openEdit(row: ClaudexModelMeta) {
  editingRow.value = row
  editorOpen.value = true
}

function closeEditor() {
  editorOpen.value = false
  editingRow.value = null
}

async function onSaved() {
  closeEditor()
  appStore.showSuccess(t('admin.claudexModels.saved'))
  // Saving a default clears the scope's previous default on the server, so reload.
  await loadRows()
  void groupPanel.value?.load()
}

/** The editor hit a changed catalog or a deleted group: reload both (a deleted group leaves the scope list). */
function onStale() {
  void loadGroups()
  void loadRows()
}

// ----- Row actions -----
const busyRowId = ref<number | null>(null)

async function makeDefault(row: ClaudexModelMeta) {
  if (busyRowId.value !== null) return
  busyRowId.value = row.id
  try {
    await runWithStepUp(
      stepUp,
      () => adminAPI.claudex.models.update(row.id, { ...inputFromRow(row), is_default: true }),
      t
    )
    appStore.showSuccess(t('admin.claudexModels.madeDefault', { model: row.model_id }))
  } catch (err) {
    if (!isStepUpCancelled(err)) appStore.showError(errorText(err, 'admin.claudex.common.saveFailed'))
  } finally {
    busyRowId.value = null
  }
  // The previous default of the scope changed too (or the row is gone): show what the server has.
  await loadRows()
}

const deletingRow = ref<ClaudexModelMeta | null>(null)

const deleteMessage = computed(() => {
  const row = deletingRow.value
  if (!row) return ''
  const scope = rowGroupName(row)
  return t('admin.claudexModels.deleteConfirm', { model: row.model_id, scope })
})

function askDelete(row: ClaudexModelMeta) {
  deletingRow.value = row
}

async function confirmDelete() {
  const row = deletingRow.value
  if (!row || busyRowId.value !== null) return
  deletingRow.value = null
  busyRowId.value = row.id
  try {
    await runWithStepUp(stepUp, () => adminAPI.claudex.models.remove(row.id), t)
    appStore.showSuccess(t('admin.claudexModels.deleted', { model: row.model_id }))
  } catch (err) {
    // Already gone is what the admin wanted; a cancelled step-up is not an error.
    if (!isStepUpCancelled(err) && claudexErrorReason(err) !== 'CLAUDEX_MODEL_META_NOT_FOUND') {
      appStore.showError(errorText(err, 'admin.claudexModels.deleteFailed'))
    }
  } finally {
    busyRowId.value = null
  }
  await loadRows()
}

onMounted(() => {
  void loadGroups()
  void loadRows()
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  listController?.abort()
})
</script>
