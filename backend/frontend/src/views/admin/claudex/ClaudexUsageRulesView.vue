<!--
  CLAUDEX: /admin/claudex/usage-rules (K3). Usage rules per group (the 5-hour
  Current session and weekly limits per model), their per-user counters with
  reset, and a user's usage as Claudex shows it. Backend: B5
  (internal/claudex/usage). Saving, deleting and resetting ask for
  confirmation and go through step-up.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexUsageRules.title')"
    :description="t('admin.claudexUsageRules.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-usage-rules-page"
    @retry="load"
  >
    <template #actions>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="refreshing"
        :title="t('admin.claudex.common.reload')"
        data-testid="claudex-rules-reload"
        @click="refresh"
      >
        <Icon name="refresh" size="md" :class="refreshing ? 'animate-spin' : ''" />
      </button>
      <button type="button" class="btn btn-primary" data-testid="claudex-rule-create" @click="openCreate(null)">
        <Icon name="plus" size="md" class="mr-1" />
        {{ t('admin.claudexUsageRules.create') }}
      </button>
    </template>

    <div class="space-y-6">
      <section class="card">
        <div class="card-header">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudexUsageRules.rulesTitle') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexUsageRules.rulesHint') }}</p>
        </div>
        <div class="card-body">
          <UsageRuleSections
            :sections="sections"
            @create="openCreate"
            @edit="openEdit"
            @counters="countersRule = $event"
            @delete="remove"
          />
        </div>
      </section>

      <UserUsageStatusCard :groups="groups" />
    </div>
  </ClaudexPageShell>

  <UsageRuleDialog
    :show="dialogOpen"
    :rule="editing"
    :groups="groups"
    :default-group-id="createGroupId"
    :saving="save.saving.value"
    :error="save.error.value"
    @close="closeDialog"
    @submit="submitRule"
  />
  <UsageCountersDrawer
    :show="countersRule !== null"
    :rule="countersRule"
    :step-up="stepUp"
    :confirm="confirm"
    @close="countersRule = null"
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
  />
  <TotpStepUpDialog :controller="stepUp" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { useConfirm } from '@/components/admin/claudex/devices/useConfirm'
import UsageRuleSections from '@/components/admin/claudex/usage/UsageRuleSections.vue'
import UsageRuleDialog from '@/components/admin/claudex/usage/UsageRuleDialog.vue'
import UsageCountersDrawer from '@/components/admin/claudex/usage/UsageCountersDrawer.vue'
import UserUsageStatusCard from '@/components/admin/claudex/usage/UserUsageStatusCard.vue'
import { groupRuleSections } from '@/components/admin/claudex/usage/rules'
import { useStepUp } from '@/composables/useStepUp'
import { useAppStore } from '@/stores'
import {
  createRule,
  deleteRule,
  listRules,
  updateRule,
  type UsageRule,
  type UsageRuleInput
} from '@/api/admin/claudex/usageRules'
import { getAll as getAllGroups } from '@/api/admin/groups'
import type { AdminGroup } from '@/types'

const { t, te } = useI18n()
const appStore = useAppStore()
const stepUp = useStepUp()
const confirm = useConfirm()
const save = useClaudexSave('claudexUsageRules')
const remover = useClaudexSave('claudexUsageRules')

const rules = ref<UsageRule[]>([])
const groups = ref<AdminGroup[]>([])
const loading = ref(true)
const refreshing = ref(false)
const loadError = ref<string | null>(null)
const dialogOpen = ref(false)
const editing = ref<UsageRule | null>(null)
const createGroupId = ref<number | null>(null)
const countersRule = ref<UsageRule | null>(null)

const groupNames = computed(() => new Map(groups.value.map((g) => [g.id, g.name])))
const sections = computed(() =>
  groupRuleSections(rules.value, groupNames.value, t('admin.claudexUsageRules.allGroups'))
)

function errorText(err: unknown): string {
  return claudexErrorMessage(err, t, te, 'claudexUsageRules', t('admin.claudex.common.loadFailed'))
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [loadedRules, allGroups] = await Promise.all([listRules(), getAllGroups()])
    rules.value = loadedRules
    groups.value = allGroups ?? []
  } catch (err) {
    loadError.value = errorText(err)
  } finally {
    loading.value = false
  }
}

async function refresh() {
  refreshing.value = true
  try {
    rules.value = await listRules()
  } catch (err) {
    appStore.showError(errorText(err))
  } finally {
    refreshing.value = false
  }
}

function groupLabel(groupId: number | null): string {
  if (groupId === null) return t('admin.claudexUsageRules.allGroups')
  return groupNames.value.get(groupId) ?? t('admin.claudexUsageRules.missingGroup', { id: groupId })
}

function openCreate(groupId: number | null) {
  save.reset()
  editing.value = null
  createGroupId.value = groupId
  dialogOpen.value = true
}

function openEdit(rule: UsageRule) {
  save.reset()
  editing.value = rule
  dialogOpen.value = true
}

function closeDialog() {
  dialogOpen.value = false
  editing.value = null
}

async function submitRule(input: UsageRuleInput) {
  const current = editing.value
  const ok = await confirm.ask({
    title: current ? t('admin.claudexUsageRules.confirm.saveTitle') : t('admin.claudexUsageRules.confirm.createTitle'),
    message: t('admin.claudexUsageRules.confirm.saveMessage', { group: groupLabel(input.group_id) }),
    confirmText: t('admin.claudexUsageRules.form.save')
  })
  if (!ok) return
  const result = await save.run(() =>
    stepUp.run(() => (current ? updateRule(current.id, input) : createRule(input)))
  )
  if (!result.ok) return
  appStore.showSuccess(t('admin.claudexUsageRules.confirm.saved'))
  closeDialog()
  await refresh()
}

async function remove(rule: UsageRule) {
  const ok = await confirm.ask({
    title: t('admin.claudexUsageRules.confirm.deleteTitle', { label: rule.label }),
    message: t('admin.claudexUsageRules.confirm.deleteMessage'),
    confirmText: t('admin.claudexUsageRules.actions.delete'),
    danger: true
  })
  if (!ok) return
  const result = await remover.run(() => stepUp.run(() => deleteRule(rule.id)))
  if (result.ok) {
    appStore.showSuccess(t('admin.claudexUsageRules.confirm.deleted'))
    if (countersRule.value?.id === rule.id) countersRule.value = null
    await refresh()
  } else if (!result.cancelled && remover.error.value) {
    appStore.showError(remover.error.value)
  }
}

onMounted(load)
</script>
