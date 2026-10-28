<!--
  CLAUDEX: create or edit one usage rule. The dialog only checks the form and
  emits the request body; the page confirms, runs step-up and saves, and
  passes `saving` and `error` back.
-->
<template>
  <BaseDialog :show="show" :title="title" width="wide" @close="emit('close')">
    <form class="space-y-5" data-testid="claudex-rule-form" novalidate @submit.prevent="submit">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <!-- Scope -->
        <div>
          <label for="claudex-rule-group" class="input-label">{{ t('admin.claudexUsageRules.form.group') }}</label>
          <select
            id="claudex-rule-group"
            v-model="form.groupId"
            class="input mt-1.5 w-full"
            data-testid="claudex-rule-group"
          >
            <option :value="null">{{ t('admin.claudexUsageRules.allGroups') }}</option>
            <option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ group.label }}</option>
          </select>
          <p class="input-hint mt-1.5">{{ t('admin.claudexUsageRules.form.groupHint') }}</p>
        </div>

        <!-- Kind -->
        <div>
          <label for="claudex-rule-kind" class="input-label">{{ t('admin.claudexUsageRules.form.kind') }}</label>
          <select
            id="claudex-rule-kind"
            v-model="form.kind"
            class="input mt-1.5 w-full"
            data-testid="claudex-rule-kind"
            @change="onKindChange"
          >
            <option value="session">{{ t('admin.claudexUsageRules.kinds.session') }}</option>
            <option value="all_models">{{ t('admin.claudexUsageRules.kinds.all_models') }}</option>
            <option value="models">{{ t('admin.claudexUsageRules.kinds.models') }}</option>
          </select>
          <p class="input-hint mt-1.5">{{ t(`admin.claudexUsageRules.kindHints.${form.kind}`) }}</p>
        </div>
      </div>

      <!-- Label -->
      <div>
        <label for="claudex-rule-label" class="input-label">{{ t('admin.claudexUsageRules.form.label') }}</label>
        <input
          id="claudex-rule-label"
          v-model="form.label"
          type="text"
          :maxlength="LABEL_MAX"
          class="input mt-1.5 w-full"
          :class="{ 'input-error': shown.label }"
          :placeholder="t('admin.claudexUsageRules.form.labelPlaceholder')"
          data-testid="claudex-rule-label"
          @input="labelTouched = true"
        />
        <p v-if="shown.label" class="input-error-text mt-1.5">{{ t(shown.label) }}</p>
        <p v-else class="input-hint mt-1.5">{{ t('admin.claudexUsageRules.form.labelHint') }}</p>
      </div>

      <!-- Model patterns -->
      <div v-if="form.kind === 'models'" data-testid="claudex-rule-patterns">
        <TagInput
          v-model="form.patterns"
          :label="t('admin.claudexUsageRules.form.patterns')"
          :placeholder="t('admin.claudexUsageRules.form.patternsPlaceholder')"
          :hint="shown.patterns ? '' : t('admin.claudexUsageRules.form.patternsHint', { max: PATTERNS_MAX })"
          :max="PATTERNS_MAX"
          case-insensitive
          :validate="validateModelPattern"
        />
        <p v-if="shown.patterns" class="input-error-text mt-1.5">{{ t(shown.patterns) }}</p>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <!-- Window -->
        <div>
          <label for="claudex-rule-window" class="input-label">{{ t('admin.claudexUsageRules.form.window') }}</label>
          <select
            id="claudex-rule-window"
            v-model="form.windowChoice"
            class="input mt-1.5 w-full"
            data-testid="claudex-rule-window"
            @change="windowTouched = true"
          >
            <option v-for="preset in WINDOW_PRESETS" :key="preset.id" :value="preset.id">
              {{ t(`admin.claudexUsageRules.window.${preset.id}`) }}
            </option>
            <option value="custom">{{ t('admin.claudexUsageRules.window.custom') }}</option>
          </select>
          <div v-if="form.windowChoice === 'custom'" class="mt-2 flex items-center gap-2">
            <input
              v-model="form.customHours"
              type="number"
              :min="CUSTOM_HOURS_MIN"
              :max="CUSTOM_HOURS_MAX"
              step="1"
              class="input w-28"
              :class="{ 'input-error': shown.window }"
              :aria-label="t('admin.claudexUsageRules.form.customHours')"
              data-testid="claudex-rule-custom-hours"
            />
            <span class="text-sm text-gray-500">{{ t('admin.claudexUsageRules.form.hours') }}</span>
          </div>
          <p v-if="shown.window" class="input-error-text mt-1.5">{{ t(shown.window) }}</p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexUsageRules.form.windowHint') }}</p>
        </div>

        <!-- Limit -->
        <div>
          <label for="claudex-rule-limit" class="input-label">{{ t('admin.claudexUsageRules.form.limit') }}</label>
          <input
            id="claudex-rule-limit"
            v-model="form.limitUsd"
            type="number"
            min="0"
            step="any"
            class="input mt-1.5 w-full"
            :class="{ 'input-error': shown.limit }"
            data-testid="claudex-rule-limit"
          />
          <p v-if="shown.limit" class="input-error-text mt-1.5">{{ t(shown.limit) }}</p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexUsageRules.form.limitHint') }}</p>
        </div>

        <!-- Sort -->
        <div>
          <label for="claudex-rule-sort" class="input-label">{{ t('admin.claudexUsageRules.form.sort') }}</label>
          <input
            id="claudex-rule-sort"
            v-model="form.sortOrder"
            type="number"
            step="1"
            class="input mt-1.5 w-full"
            :class="{ 'input-error': shown.sort }"
            data-testid="claudex-rule-sort"
          />
          <p v-if="shown.sort" class="input-error-text mt-1.5">{{ t(shown.sort) }}</p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexUsageRules.form.sortHint') }}</p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-white">{{ t('admin.claudexUsageRules.form.enabled') }}</p>
            <p class="input-hint mt-1">{{ t('admin.claudexUsageRules.form.enabledHint') }}</p>
          </div>
          <Toggle v-model="form.enabled" data-testid="claudex-rule-enabled" />
        </div>
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-white">
              {{ t('admin.claudexUsageRules.form.showInClient') }}
            </p>
            <p class="input-hint mt-1">{{ t('admin.claudexUsageRules.form.showInClientHint') }}</p>
          </div>
          <Toggle v-model="form.showInClient" data-testid="claudex-rule-show" />
        </div>
      </div>

      <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-400" data-testid="claudex-rule-error">
        {{ error }}
      </p>
    </form>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-secondary" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="saving"
          data-testid="claudex-rule-submit"
          @click="submit"
        >
          {{ saving ? t('admin.claudex.common.saving') : t('admin.claudexUsageRules.form.save') }}
        </button>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import Toggle from '@/components/common/Toggle.vue'
import TagInput from '@/components/admin/claudex/common/TagInput.vue'
import type { UsageRule, UsageRuleInput } from '@/api/admin/claudex/usageRules'
import type { AdminGroup } from '@/types'
import {
  CUSTOM_HOURS_MAX,
  CUSTOM_HOURS_MIN,
  DEFAULT_LABEL_KEY,
  DEFAULT_WINDOW_BY_KIND,
  LABEL_MAX,
  PATTERNS_MAX,
  WINDOW_PRESETS,
  emptyRuleForm,
  formToInput,
  ruleToForm,
  validateModelPattern,
  validateRuleForm,
  type RuleErrors,
  type RuleForm
} from './rules'

const props = withDefaults(
  defineProps<{
    show: boolean
    /** null = a new rule. */
    rule: UsageRule | null
    groups: AdminGroup[]
    /** Group preselected for a new rule. */
    defaultGroupId?: number | null
    saving?: boolean
    error?: string | null
  }>(),
  { defaultGroupId: null, saving: false, error: null }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', value: UsageRuleInput): void
}>()

const { t } = useI18n()
const form = reactive<RuleForm>(emptyRuleForm())
const attempted = ref(false)
const labelTouched = ref(false)
const windowTouched = ref(false)

const title = computed(() =>
  props.rule ? t('admin.claudexUsageRules.form.editTitle') : t('admin.claudexUsageRules.form.createTitle')
)

function defaultLabel(kind: RuleForm['kind']): string {
  const key = DEFAULT_LABEL_KEY[kind]
  return key ? t(key) : ''
}

function resetForm() {
  const next = props.rule ? ruleToForm(props.rule) : emptyRuleForm(props.defaultGroupId ?? null)
  if (!props.rule) next.label = defaultLabel(next.kind)
  Object.assign(form, next)
  attempted.value = false
  labelTouched.value = !!props.rule
  windowTouched.value = !!props.rule
}

watch(
  () => [props.show, props.rule] as const,
  ([show]) => {
    if (show) resetForm()
  },
  { immediate: true }
)

/** A new rule follows the kind with its default window and label until they are edited. */
function onKindChange() {
  if (!windowTouched.value) {
    form.windowChoice = DEFAULT_WINDOW_BY_KIND[form.kind]
    form.customHours = null
  }
  const defaults = Object.values(DEFAULT_LABEL_KEY)
    .filter((key): key is string => !!key)
    .map((key) => t(key))
  if (!labelTouched.value || !form.label.trim() || defaults.includes(form.label.trim())) {
    form.label = defaultLabel(form.kind)
    labelTouched.value = false
  }
}

const groupOptions = computed(() => {
  const options = props.groups.map((g) => ({ id: g.id, label: g.name }))
  if (form.groupId !== null && !props.groups.some((g) => g.id === form.groupId)) {
    const name = props.rule?.group_name || t('admin.claudexUsageRules.missingGroup', { id: form.groupId })
    options.push({
      id: form.groupId,
      label: props.rule?.group_deleted ? t('admin.claudexUsageRules.deletedGroupOption', { name }) : name
    })
  }
  return options
})

const errors = computed<RuleErrors>(() => validateRuleForm(form))
const shown = computed<RuleErrors>(() => (attempted.value ? errors.value : {}))

function submit() {
  attempted.value = true
  if (Object.keys(errors.value).length > 0) return
  emit('submit', formToInput(form))
}
</script>
