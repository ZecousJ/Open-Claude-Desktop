<!--
  CLAUDEX: /admin/claudex/policy, the client policy the Claudex desktop app
  follows (settings key claudex_client_policy, backend internal/claudex/policy).

  Tabs: Defaults, Plan overrides, User overrides and Preview. The three
  editing tabs change one draft; Save sends it in one PUT with the revision
  the edit started from, through step-up. A 409 means someone else saved in
  between: the page says so and offers Reload.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexPolicy.title')"
    :description="t('admin.claudexPolicy.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-policy-page"
    @retry="load"
  >
    <template #actions>
      <span v-if="draft" class="text-xs text-gray-500 dark:text-gray-400" data-testid="policy-revision">
        {{ revisionText }}
      </span>
      <button
        v-if="draft"
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="policy-reload"
        @click="askReload"
      >
        <Icon name="refresh" size="sm" class="mr-1" />
        {{ t('admin.claudex.common.reload') }}
      </button>
    </template>

    <div v-if="draft" class="card">
      <div
        class="flex gap-1 overflow-x-auto border-b border-gray-100 px-4 dark:border-dark-700"
        role="tablist"
        :aria-label="t('admin.claudexPolicy.title')"
      >
        <button
          v-for="tab in TABS"
          :key="tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab ? 'true' : 'false'"
          class="-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors"
          :class="
            activeTab === tab
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
          "
          :data-testid="`policy-tab-${tab}`"
          @click="activeTab = tab"
        >
          {{ t(`admin.claudexPolicy.tabs.${tab}`) }}
          <span
            v-if="showErrors && tabHasIssues(tab)"
            class="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300"
          >
            {{ t('admin.claudexPolicy.issuesBadge') }}
          </span>
        </button>
      </div>

      <div class="space-y-4 p-6">
        <p class="text-sm text-gray-500 dark:text-gray-400">
          {{ t(`admin.claudexPolicy.tabDescriptions.${activeTab}`) }}
        </p>

        <PolicyPatchEditor
          v-if="activeTab === 'defaults'"
          v-model="draft.defaults"
          mode="defaults"
          :inherited="builtin"
          :fallbacks="fallbacks"
          :show-errors="showErrors"
        />

        <div v-else-if="activeTab === 'plans'" class="space-y-3" data-testid="policy-plans">
          <div class="flex justify-end">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              data-testid="policy-add-plan"
              @click="openPlanDialog(null)"
            >
              <Icon name="plus" size="sm" class="mr-1" />
              {{ t('admin.claudexPolicy.plans.add') }}
            </button>
          </div>
          <DataTable :columns="planColumns" :data="planRows" row-key="group_id">
            <template #cell-name="{ row }">
              <span class="font-medium text-gray-900 dark:text-white">{{ row.name }}</span>
              <span
                v-if="row.inactive"
                class="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-dark-700 dark:text-gray-400"
              >
                {{ t('admin.claudexPolicy.plans.inactive') }}
              </span>
              <span
                v-if="showErrors && row.hasIssues"
                class="ml-2 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300"
              >
                {{ t('admin.claudexPolicy.issuesBadge') }}
              </span>
            </template>
            <template #cell-actions="{ row }">
              <div class="flex gap-2">
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :data-testid="`policy-edit-plan-${row.group_id}`"
                  @click="openPlanDialog(row.group_id)"
                >
                  {{ t('admin.claudexPolicy.plans.edit') }}
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :data-testid="`policy-remove-plan-${row.group_id}`"
                  @click="removePlan(row.group_id)"
                >
                  {{ t('admin.claudexPolicy.plans.remove') }}
                </button>
              </div>
            </template>
            <template #empty>
              <p class="py-6 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexPolicy.plans.empty') }}</p>
            </template>
          </DataTable>
        </div>

        <div v-else-if="activeTab === 'users'" class="space-y-3" data-testid="policy-users">
          <div class="flex justify-end">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              data-testid="policy-add-user"
              @click="openUserDialog(null)"
            >
              <Icon name="plus" size="sm" class="mr-1" />
              {{ t('admin.claudexPolicy.users.add') }}
            </button>
          </div>
          <DataTable :columns="userColumns" :data="userRows" row-key="user_id">
            <template #cell-email="{ row }">
              <span class="font-medium text-gray-900 dark:text-white">{{ row.email }}</span>
              <span
                v-if="showErrors && row.hasIssues"
                class="ml-2 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300"
              >
                {{ t('admin.claudexPolicy.issuesBadge') }}
              </span>
            </template>
            <template #cell-actions="{ row }">
              <div class="flex gap-2">
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :data-testid="`policy-edit-user-${row.user_id}`"
                  @click="openUserDialog(row.user_id)"
                >
                  {{ t('admin.claudexPolicy.users.edit') }}
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :data-testid="`policy-remove-user-${row.user_id}`"
                  @click="removeUser(row.user_id)"
                >
                  {{ t('admin.claudexPolicy.users.remove') }}
                </button>
              </div>
            </template>
            <template #empty>
              <p class="py-6 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexPolicy.users.empty') }}</p>
            </template>
          </DataTable>
        </div>

        <PolicyPreview v-else :groups="groupList" :draft="() => requestBody" :dirty="dirty" />
      </div>

      <PolicyOverrideDialog
        :show="dialog.show"
        :kind="dialog.kind"
        :target="dialog.target"
        :patch="dialog.patch"
        :inherited="overrideInherited"
        :fallbacks="fallbacks"
        :group-options="newGroupOptions"
        :excluded-user-ids="draft.users.map((entry) => entry.user_id)"
        @close="dialog.show = false"
        @apply="applyDialog"
      />
    </div>

    <template #footer>
      <div v-if="draft" class="space-y-2">
        <SaveBar
          :saving="save.saving.value"
          :dirty="dirty"
          :saved="save.saved.value && !dirty"
          :error="saveError"
          @save="submit"
        >
          <template #extra>
            <span v-if="!saveError" class="text-xs text-gray-400 dark:text-gray-500">{{
              t('admin.claudexPolicy.saveHint')
            }}</span>
            <button
              v-if="conflict"
              type="button"
              class="btn btn-secondary"
              data-testid="policy-conflict-reload"
              @click="load"
            >
              {{ t('admin.claudex.common.reload') }}
            </button>
          </template>
        </SaveBar>
        <p
          v-if="serverField"
          class="text-right text-xs text-red-600 dark:text-red-400"
          data-testid="policy-server-field"
        >
          {{ serverField }}
        </p>
      </div>
      <ConfirmDialog
        :show="confirmReload"
        :title="t('admin.claudexPolicy.reloadConfirmTitle')"
        :message="t('admin.claudexPolicy.reloadConfirmMessage')"
        :confirm-text="t('admin.claudex.common.reload')"
        danger
        @confirm="confirmedReload"
        @cancel="confirmReload = false"
      />
      <TotpStepUpDialog :controller="stepUp" />
    </template>
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import DataTable from '@/components/common/DataTable.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { extractApiErrorMessage, extractApiErrorMetadata } from '@/utils/apiError'
import PolicyPatchEditor from '@/components/admin/claudex/policy/PolicyPatchEditor.vue'
import PolicyOverrideDialog from '@/components/admin/claudex/policy/PolicyOverrideDialog.vue'
import PolicyPreview from '@/components/admin/claudex/policy/PolicyPreview.vue'
import {
  BUILTIN_POLICY,
  applyPatch,
  buildUpdateRequest,
  builtinFromResolved,
  cleanPatch,
  countItems,
  draftFromServer,
  validateUpdateRequest,
  type FullPolicy,
  type GroupOption,
  type OverrideTarget,
  type PolicyDraft,
  type PolicyIssue
} from '@/components/admin/claudex/policy/policyForm'
import { useStepUp } from '@/composables/useStepUp'
import { formatDateTime } from '@/utils/format'
import { platformLabel } from '@/utils/platformColors'
import {
  get as getPolicy,
  update as updatePolicy,
  type AdminClientPolicy,
  type PolicyPatch
} from '@/api/admin/claudex/policy'
import { getAllIncludingInactive } from '@/api/admin/groups'
import type { Column } from '@/components/common/types'

type Tab = 'defaults' | 'plans' | 'users' | 'preview'
const TABS: Tab[] = ['defaults', 'plans', 'users', 'preview']

interface GroupInfo {
  id: number
  name: string
  platform: string
  inactive: boolean
}

const { t } = useI18n()
const stepUp = useStepUp()
const save = useClaudexSave('claudexPolicy')

const loading = ref(true)
const loadError = ref<string | null>(null)
const activeTab = ref<Tab>('defaults')
const draft = ref<PolicyDraft | null>(null)
const savedSnapshot = ref('')
const savedMeta = reactive({ revision: 0, updatedAt: '' as string, updatedBy: 0 })
const builtin = ref<FullPolicy>(JSON.parse(JSON.stringify(BUILTIN_POLICY)))
const fallbacks = ref<AdminClientPolicy['fallbacks']>(null)
const groups = ref<GroupInfo[]>([])
const showErrors = ref(false)
const validationError = ref<string | null>(null)
const confirmReload = ref(false)

const dialog = reactive<{
  show: boolean
  kind: 'plan' | 'user'
  target: OverrideTarget | null
  patch: PolicyPatch
}>({ show: false, kind: 'plan', target: null, patch: {} })

function applyServer(policy: AdminClientPolicy): void {
  const next = draftFromServer(policy)
  draft.value = next
  savedSnapshot.value = JSON.stringify(buildUpdateRequest(next))
  savedMeta.revision = next.revision
  savedMeta.updatedAt = policy.updated_at ?? ''
  savedMeta.updatedBy = policy.updated_by ?? 0
  builtin.value = builtinFromResolved(policy.builtin)
  fallbacks.value = policy.fallbacks ?? null
  showErrors.value = false
  validationError.value = null
}

async function loadGroups(): Promise<void> {
  try {
    const list = await getAllIncludingInactive()
    groups.value = (list ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      platform: group.platform,
      inactive: group.status !== 'active'
    }))
  } catch {
    // Names then come from the policy itself (group_name); adding a plan lists nothing.
    groups.value = []
  }
}

async function load(): Promise<void> {
  loading.value = draft.value === null
  loadError.value = null
  save.reset()
  try {
    const [policy] = await Promise.all([getPolicy(), loadGroups()])
    applyServer(policy)
  } catch (err) {
    if (draft.value === null) loadError.value = extractApiErrorMessage(err, t('admin.claudex.common.loadFailed'))
    else validationError.value = extractApiErrorMessage(err, t('admin.claudex.common.loadFailed'))
  } finally {
    loading.value = false
  }
}

function askReload(): void {
  if (dirty.value) confirmReload.value = true
  else void load()
}

function confirmedReload(): void {
  confirmReload.value = false
  void load()
}

/** "Revision 17 · Last saved … by user #1", or that the built-in defaults apply. */
const revisionText = computed(() => {
  if (savedMeta.revision <= 0) return t('admin.claudexPolicy.neverSaved')
  const parts = [t('admin.claudexPolicy.revision', { revision: savedMeta.revision })]
  if (savedMeta.updatedAt) {
    let saved = t('admin.claudexPolicy.updatedAt', { time: formatDateTime(savedMeta.updatedAt) })
    if (savedMeta.updatedBy) saved += ` ${t('admin.claudexPolicy.updatedBy', { id: savedMeta.updatedBy })}`
    parts.push(saved)
  }
  return parts.join(' · ')
})

// Draft state

const requestBody = computed(() => (draft.value ? buildUpdateRequest(draft.value) : null)!)
const dirty = computed(() => draft.value !== null && JSON.stringify(requestBody.value) !== savedSnapshot.value)
const issues = computed<PolicyIssue[]>(() => (draft.value ? validateUpdateRequest(requestBody.value) : []))

function tabHasIssues(tab: Tab): boolean {
  const prefix =
    tab === 'defaults' ? 'defaults.' : tab === 'plans' ? 'group_overrides.' : tab === 'users' ? 'user_overrides.' : null
  return prefix !== null && issues.value.some((issue) => issue.field.startsWith(prefix))
}

/** What overrides inherit: the built-in defaults with the (draft) defaults over them. */
const overrideInherited = computed<FullPolicy>(() =>
  JSON.parse(JSON.stringify(applyPatch(builtin.value, cleanPatch(draft.value?.defaults ?? {}))))
)

const groupList = computed(() => {
  const known = new Map(groups.value.map((group) => [group.id, group.name]))
  for (const entry of draft.value?.groups ?? []) {
    if (!known.has(entry.group_id))
      known.set(entry.group_id, entry.group_name || t('admin.claudexPolicy.plans.deletedGroup', { id: entry.group_id }))
  }
  return [...known].map(([id, name]) => ({ id, name }))
})

const newGroupOptions = computed<GroupOption[]>(() => {
  const taken = new Set((draft.value?.groups ?? []).map((entry) => entry.group_id))
  return groups.value
    .filter((group) => !taken.has(group.id))
    .map((group) => ({ value: group.id, label: group.name, platform: group.platform }))
})

const planColumns = computed<Column[]>(() => [
  { key: 'name', label: t('admin.claudexPolicy.plans.group') },
  { key: 'platform', label: t('admin.claudexPolicy.plans.platform') },
  { key: 'overrides', label: t('admin.claudexPolicy.plans.overrides') },
  { key: 'label', label: t('admin.claudexPolicy.plans.label') },
  { key: 'actions', label: t('admin.claudexPolicy.plans.actions') }
])

const userColumns = computed<Column[]>(() => [
  { key: 'email', label: t('admin.claudexPolicy.users.user') },
  { key: 'user_id', label: t('admin.claudexPolicy.users.id') },
  { key: 'overrides', label: t('admin.claudexPolicy.users.overrides') },
  { key: 'actions', label: t('admin.claudexPolicy.users.actions') }
])

const planRows = computed(() =>
  (draft.value?.groups ?? []).map((entry) => {
    const group = groups.value.find((item) => item.id === entry.group_id)
    return {
      group_id: entry.group_id,
      name: group?.name || entry.group_name || t('admin.claudexPolicy.plans.deletedGroup', { id: entry.group_id }),
      platform: group ? platformLabel(group.platform) : '',
      inactive: group?.inactive ?? false,
      overrides: countItems(entry.patch),
      label: typeof entry.patch.plan_label === 'string' && entry.patch.plan_label.trim() ? entry.patch.plan_label : '—',
      hasIssues: issues.value.some((issue) => issue.field.startsWith(`group_overrides.${entry.group_id}.`))
    }
  })
)

const userRows = computed(() =>
  (draft.value?.users ?? []).map((entry) => ({
    user_id: entry.user_id,
    email: entry.email || `#${entry.user_id}`,
    overrides: countItems(entry.patch),
    hasIssues: issues.value.some((issue) => issue.field.startsWith(`user_overrides.${entry.user_id}.`))
  }))
)

// Override dialogs

function openPlanDialog(groupId: number | null): void {
  const entry = groupId === null ? null : draft.value?.groups.find((item) => item.group_id === groupId)
  dialog.kind = 'plan'
  dialog.target = entry
    ? { id: entry.group_id, name: planRows.value.find((row) => row.group_id === entry.group_id)?.name ?? '' }
    : null
  dialog.patch = entry ? entry.patch : {}
  dialog.show = true
}

function openUserDialog(userId: number | null): void {
  const entry = userId === null ? null : draft.value?.users.find((item) => item.user_id === userId)
  dialog.kind = 'user'
  dialog.target = entry ? { id: entry.user_id, name: entry.email || `#${entry.user_id}` } : null
  dialog.patch = entry ? entry.patch : {}
  dialog.show = true
}

function applyDialog(value: { target: OverrideTarget; patch: PolicyPatch }): void {
  if (!draft.value) return
  if (dialog.kind === 'plan') {
    const existing = draft.value.groups.find((entry) => entry.group_id === value.target.id)
    if (existing) existing.patch = value.patch
    else draft.value.groups.push({ group_id: value.target.id, group_name: value.target.name, patch: value.patch })
  } else {
    const existing = draft.value.users.find((entry) => entry.user_id === value.target.id)
    if (existing) existing.patch = value.patch
    else draft.value.users.push({ user_id: value.target.id, email: value.target.name, patch: value.patch })
  }
  dialog.show = false
}

function removePlan(groupId: number): void {
  if (draft.value) draft.value.groups = draft.value.groups.filter((entry) => entry.group_id !== groupId)
}

function removeUser(userId: number): void {
  if (draft.value) draft.value.users = draft.value.users.filter((entry) => entry.user_id !== userId)
}

// Save

const conflict = computed(() => save.reason.value === 'CLAUDEX_POLICY_REVISION_CONFLICT')

const saveError = computed(() => validationError.value || save.error.value)

/** For CLAUDEX_POLICY_INVALID: which field the server rejected and why. */
const serverField = computed(() => {
  if (save.reason.value !== 'CLAUDEX_POLICY_INVALID') return ''
  const metadata = extractApiErrorMetadata(save.lastError.value) ?? {}
  const field = typeof metadata.field === 'string' ? metadata.field : ''
  const rule = typeof metadata.rule === 'string' ? metadata.rule : ''
  return field ? t('admin.claudexPolicy.serverField', { field, rule }) : ''
})

async function submit(): Promise<void> {
  if (!draft.value) return
  const body = requestBody.value
  validationError.value = null
  const problems = validateUpdateRequest(body)
  if (problems.length > 0) {
    showErrors.value = true
    save.reset()
    validationError.value =
      problems[0].rule === 'too_large'
        ? t('admin.claudexPolicy.validation.too_large')
        : t('admin.claudexPolicy.validationFailed')
    const firstTab = TABS.find((tab) => tabHasIssues(tab))
    if (firstTab) activeTab.value = firstTab
    return
  }
  const result = await save.run(() => stepUp.run(() => updatePolicy(body)))
  if (!result.ok) return
  if (result.value && typeof result.value.revision === 'number' && result.value.defaults) {
    applyServer(result.value)
  } else {
    await load()
  }
  save.saved.value = true
}

void load()
</script>
