<!--
  CLAUDEX: dialog that adds or edits one plan override or user override of
  the client policy. "Apply" puts the patch into the page's draft; the page's
  Save button sends everything in one PUT.
-->
<template>
  <BaseDialog :show="show" :title="title" width="extra-wide" @close="emit('close')">
    <div class="space-y-5" data-testid="policy-override-dialog" :data-kind="kind">
      <div v-if="adding">
        <template v-if="kind === 'plan'">
          <label class="input-label mb-1.5 block">{{ t('admin.claudexPolicy.plans.chooseGroup') }}</label>
          <p v-if="groupOptions.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexPolicy.plans.noGroupsLeft') }}
          </p>
          <Select
            v-else
            :model-value="chosen?.id ?? null"
            :options="groupOptions"
            :placeholder="t('admin.claudexPolicy.plans.chooseGroupPlaceholder')"
            searchable
            data-testid="policy-group-select"
            @change="onGroupChange"
          />
        </template>
        <template v-else>
          <div
            v-if="chosen"
            class="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-dark-600"
          >
            <span class="text-sm text-gray-900 dark:text-white" data-testid="policy-chosen-user">
              <span class="text-gray-400">#{{ chosen.id }}</span> {{ chosen.name }}
            </span>
            <button type="button" class="btn btn-secondary btn-sm" @click="chosen = null">
              {{ t('admin.claudexPolicy.users.clear') }}
            </button>
          </div>
          <PolicyUserPicker
            v-else
            :label="t('admin.claudexPolicy.users.chooseUser')"
            :excluded-ids="excludedUserIds"
            @select="chosen = { id: $event.id, name: $event.email }"
          />
        </template>
      </div>

      <PolicyPatchEditor
        v-model="working"
        :mode="kind"
        :inherited="inherited"
        :fallbacks="fallbacks"
        :show-errors="showErrors"
      />
    </div>

    <template #footer>
      <div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p
          v-if="problem"
          role="alert"
          class="text-sm text-red-600 dark:text-red-400 sm:mr-auto"
          data-testid="policy-dialog-error"
        >
          {{ problem }}
        </p>
        <p v-else class="text-xs text-gray-500 dark:text-gray-400 sm:mr-auto">
          {{ t('admin.claudexPolicy.dialog.applyHint') }}
        </p>
        <button type="button" class="btn btn-secondary" @click="emit('close')">
          {{ t('admin.claudexPolicy.dialog.cancel') }}
        </button>
        <button type="button" class="btn btn-primary" data-testid="policy-dialog-apply" @click="apply">
          {{ t('admin.claudexPolicy.dialog.apply') }}
        </button>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import Select from '@/components/common/Select.vue'
import PolicyPatchEditor from './PolicyPatchEditor.vue'
import PolicyUserPicker from './PolicyUserPicker.vue'
import { cleanPatch, validatePatch, type FullPolicy, type GroupOption, type OverrideTarget } from './policyForm'
import type { PolicyPatch } from '@/api/admin/claudex/policy'

const props = withDefaults(
  defineProps<{
    show: boolean
    kind: 'plan' | 'user'
    /** Who the override is for; null while adding (the dialog asks). */
    target: OverrideTarget | null
    patch: PolicyPatch
    inherited: FullPolicy
    fallbacks?: { doc_url?: string | null; purchase_subscription_url?: string | null } | null
    /** Groups that can get a new plan override. */
    groupOptions?: GroupOption[]
    /** Users that already have an override. */
    excludedUserIds?: number[]
  }>(),
  { fallbacks: null, groupOptions: () => [], excludedUserIds: () => [] }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', value: { target: OverrideTarget; patch: PolicyPatch }): void
}>()

const { t } = useI18n()

const working = ref<PolicyPatch>({})
const chosen = ref<OverrideTarget | null>(null)
const showErrors = ref(false)
const problem = ref('')
const adding = computed(() => props.target === null)

watch(
  () => props.show,
  (open) => {
    if (!open) return
    working.value = JSON.parse(JSON.stringify(props.patch ?? {}))
    chosen.value = props.target ? { ...props.target } : null
    showErrors.value = false
    problem.value = ''
  },
  { immediate: true }
)

const title = computed(() => {
  if (props.kind === 'plan') {
    return adding.value
      ? t('admin.claudexPolicy.plans.addTitle')
      : t('admin.claudexPolicy.plans.editTitle', { name: props.target?.name ?? '' })
  }
  return adding.value
    ? t('admin.claudexPolicy.users.addTitle')
    : t('admin.claudexPolicy.users.editTitle', { email: props.target?.name ?? '' })
})

function onGroupChange(value: unknown, option: { label?: string } | null): void {
  chosen.value = typeof value === 'number' ? { id: value, name: option?.label ?? String(value) } : null
}

function apply(): void {
  if (!chosen.value) {
    problem.value = t('admin.claudexPolicy.dialog.chooseFirst')
    return
  }
  if (validatePatch(cleanPatch(working.value)).length > 0) {
    showErrors.value = true
    problem.value = t('admin.claudexPolicy.dialog.fixErrors')
    return
  }
  problem.value = ''
  emit('apply', { target: { ...chosen.value }, patch: JSON.parse(JSON.stringify(working.value)) })
}
</script>
