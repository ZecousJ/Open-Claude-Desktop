<!--
  CLAUDEX: add or edit one model catalog entry (K2, design §2.4 / §3.2). The
  model name can be picked from the scope's candidates (group allowlist,
  default mapped model, channel pricing) or typed. Scope and model are fixed
  once an entry exists. Emits `saved` with the saved row; the page reloads the
  list, since making an entry the default clears the previous default. Saving
  goes through step-up (R13). Fast mode was dropped (R6): there is no Fast
  field, and an entry keeps whatever fast_tier it had.
-->
<template>
  <BaseDialog
    :show="show"
    :title="isEditing ? t('admin.claudexModels.editor.editTitle') : t('admin.claudexModels.editor.createTitle')"
    width="wide"
    @close="close"
  >
    <form
      id="claudex-model-form"
      class="space-y-5"
      novalidate
      data-testid="claudex-model-form"
      @submit.prevent="submit"
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label class="input-label" :for="`${uid}-scope`">{{ t('admin.claudexModels.editor.scope') }}</label>
          <Select
            :id="`${uid}-scope`"
            v-model="scopeValue"
            :options="scopeOptions"
            :disabled="isEditing"
            :error="!!visibleProblem('group_id')"
            :aria-label="t('admin.claudexModels.editor.scope')"
            data-testid="claudex-model-scope"
          />
          <p
            v-if="visibleProblem('group_id')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-group_id"
          >
            {{ problemText('group_id') }}
          </p>
          <p v-else class="input-hint mt-1.5">
            {{
              isEditing
                ? t('admin.claudexModels.editor.scopeLocked')
                : form.group_id === null
                  ? t('admin.claudexModels.editor.scopeHintGlobal')
                  : t('admin.claudexModels.editor.scopeHintGroup')
            }}
          </p>
        </div>

        <div>
          <label class="input-label" :for="`${uid}-model`">
            {{ t('admin.claudexModels.editor.model') }}
            <span class="text-red-500">*</span>
          </label>
          <input
            :id="`${uid}-model`"
            v-model="form.model_id"
            type="text"
            class="input font-mono"
            :class="{ 'input-error': visibleProblem('model_id') }"
            :list="`${uid}-candidates`"
            :disabled="isEditing"
            :placeholder="t('admin.claudexModels.editor.modelPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            data-testid="claudex-model-id"
          />
          <datalist :id="`${uid}-candidates`" data-testid="claudex-model-candidates">
            <option v-for="model in candidateModels" :key="model" :value="model">{{ sourceLabel(model) }}</option>
          </datalist>
          <p
            v-if="visibleProblem('model_id')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-model_id"
          >
            {{ problemText('model_id') }}
          </p>
          <p
            v-else-if="notInCandidates"
            class="mt-1.5 text-xs text-amber-600 dark:text-amber-400"
            data-testid="claudex-model-not-candidate"
          >
            {{ t('admin.claudexModels.editor.notInCandidates') }}
          </p>
          <p v-else class="input-hint mt-1.5" data-testid="claudex-model-candidates-status">{{ candidatesStatus }}</p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label class="input-label" :for="`${uid}-display-name`">{{
            t('admin.claudexModels.editor.displayName')
          }}</label>
          <input
            :id="`${uid}-display-name`"
            v-model="form.display_name"
            type="text"
            class="input"
            :class="{ 'input-error': visibleProblem('display_name') }"
            :placeholder="form.model_id.trim() || t('admin.claudexModels.editor.displayNamePlaceholder')"
            data-testid="claudex-model-display-name"
          />
          <p
            v-if="visibleProblem('display_name')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-display_name"
          >
            {{ problemText('display_name') }}
          </p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.displayNameHint') }}</p>
        </div>
        <div>
          <label class="input-label" :for="`${uid}-usage-hint`">{{ t('admin.claudexModels.editor.usageHint') }}</label>
          <input
            :id="`${uid}-usage-hint`"
            v-model="form.usage_hint"
            type="text"
            class="input"
            :class="{ 'input-error': visibleProblem('usage_hint') }"
            :placeholder="t('admin.claudexModels.editor.usageHintPlaceholder')"
            data-testid="claudex-model-usage-hint"
          />
          <p
            v-if="visibleProblem('usage_hint')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-usage_hint"
          >
            {{ problemText('usage_hint') }}
          </p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.usageHintHint') }}</p>
        </div>
      </div>

      <div>
        <label class="input-label" :for="`${uid}-minimum-version`">{{ t('admin.claudexModels.editor.minimumDesktopVersion') }}</label>
        <input
          :id="`${uid}-minimum-version`"
          v-model="form.minimum_desktop_version"
          class="input"
          :class="{ 'input-error': visibleProblem('minimum_desktop_version') }"
          type="text"
          maxlength="32"
        />
        <p v-if="visibleProblem('minimum_desktop_version')" class="input-error-text mt-1.5">
          {{ problemText('minimum_desktop_version') }}
        </p>
      </div>
      <div>
        <label class="input-label" :for="`${uid}-description`">{{ t('admin.claudexModels.editor.description') }}</label>
        <textarea
          :id="`${uid}-description`"
          v-model="form.description"
          rows="2"
          class="input"
          :class="{ 'input-error': visibleProblem('description') }"
          :placeholder="t('admin.claudexModels.editor.descriptionPlaceholder')"
          data-testid="claudex-model-description"
        ></textarea>
        <p
          v-if="visibleProblem('description')"
          class="input-error-text mt-1.5"
          data-testid="claudex-model-error-description"
        >
          {{ problemText('description') }}
        </p>
        <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.descriptionHint') }}</p>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
        <div data-testid="claudex-model-badges">
          <TagInput
            :id="`${uid}-badges`"
            v-model="form.badges"
            :label="t('admin.claudexModels.editor.badges')"
            :max="BADGES_MAX"
            case-insensitive
            :validate="badgeProblemKey"
            :placeholder="t('admin.claudexModels.editor.badgesPlaceholder')"
            :hint="visibleProblem('badges') ? '' : t('admin.claudexModels.editor.badgesHint', { max: BADGES_MAX })"
          />
          <p v-if="visibleProblem('badges')" class="input-error-text mt-1.5" data-testid="claudex-model-error-badges">
            {{ problemText('badges') }}
          </p>
        </div>
        <div>
          <label class="input-label" :for="`${uid}-sort`">{{ t('admin.claudexModels.editor.sort') }}</label>
          <input
            :id="`${uid}-sort`"
            v-model="form.sort_order"
            type="number"
            step="1"
            class="input"
            :class="{ 'input-error': visibleProblem('sort_order') }"
            data-testid="claudex-model-sort"
          />
          <p
            v-if="visibleProblem('sort_order')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-sort_order"
          >
            {{ problemText('sort_order') }}
          </p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.sortHint') }}</p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-dark-600">
          <input
            v-model="form.hidden"
            type="checkbox"
            class="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-500"
            data-testid="claudex-model-hidden"
          />
          <span>
            <span class="block text-sm font-medium text-gray-900 dark:text-white">
              {{ t('admin.claudexModels.editor.hidden') }}
            </span>
            <span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400" data-testid="claudex-model-hidden-hint">
              {{ t('admin.claudexModels.editor.hiddenHint') }}
            </span>
          </span>
        </label>
        <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-dark-600">
          <input
            v-model="form.is_default"
            type="checkbox"
            class="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-500"
            data-testid="claudex-model-default"
          />
          <span>
            <span class="block text-sm font-medium text-gray-900 dark:text-white">
              {{ t('admin.claudexModels.editor.default') }}
            </span>
            <span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexModels.editor.defaultHint') }}
            </span>
          </span>
        </label>
      </div>

      <fieldset class="space-y-2" data-testid="claudex-model-efforts">
        <legend class="input-label">{{ t('admin.claudexModels.editor.efforts') }}</legend>
        <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            :checked="!form.efforts_known"
            type="checkbox"
            class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-500"
            data-testid="claudex-model-efforts-unknown"
            @change="setEffortsKnown(!($event.target as HTMLInputElement).checked)"
          />
          {{ t('admin.claudexModels.editor.effortsUnknown') }}
        </label>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="effort in CLAUDEX_MODEL_EFFORTS"
            :key="effort"
            class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs"
            :class="
              form.efforts_known
                ? 'cursor-pointer border-gray-200 text-gray-800 dark:border-dark-600 dark:text-gray-100'
                : 'cursor-not-allowed border-gray-100 text-gray-400 dark:border-dark-700 dark:text-dark-500'
            "
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-500"
              :value="effort"
              :checked="form.supported_efforts.includes(effort)"
              :disabled="!form.efforts_known"
              :data-testid="`claudex-model-effort-${effort}`"
              @change="toggleEffort(effort, ($event.target as HTMLInputElement).checked)"
            />
            {{ effort }}
          </label>
        </div>
        <p
          v-if="visibleProblem('supported_efforts')"
          class="input-error-text"
          data-testid="claudex-model-error-supported_efforts"
        >
          {{ problemText('supported_efforts') }}
        </p>
        <p v-else class="input-hint">{{ t('admin.claudexModels.editor.effortsHint') }}</p>
        <p
          v-if="effortsCut.length > 0"
          class="text-xs text-amber-600 dark:text-amber-400"
          data-testid="claudex-model-effort-ceiling"
        >
          {{
            t('admin.claudexModels.editor.effortCeiling', {
              max: selectedGroup?.max_reasoning_effort,
              efforts: effortsCut.join(', ')
            })
          }}
        </p>
      </fieldset>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label class="input-label" :for="`${uid}-default-effort`">{{
            t('admin.claudexModels.editor.defaultEffort')
          }}</label>
          <Select
            :id="`${uid}-default-effort`"
            v-model="form.default_effort"
            :options="defaultEffortOptions"
            :disabled="!form.efforts_known || form.supported_efforts.length === 0"
            :error="!!visibleProblem('default_effort')"
            :aria-label="t('admin.claudexModels.editor.defaultEffort')"
            data-testid="claudex-model-default-effort"
          />
          <p
            v-if="visibleProblem('default_effort')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-default_effort"
          >
            {{ problemText('default_effort') }}
          </p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.defaultEffortHint') }}</p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label class="input-label" :for="`${uid}-context`">{{ t('admin.claudexModels.editor.contextWindow') }}</label>
          <input
            :id="`${uid}-context`"
            v-model="form.context_window"
            type="number"
            min="1"
            step="1"
            class="input"
            :class="{ 'input-error': visibleProblem('context_window') }"
            :placeholder="t('admin.claudexModels.editor.notSet')"
            data-testid="claudex-model-context-window"
          />
          <p
            v-if="visibleProblem('context_window')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-context_window"
          >
            {{ problemText('context_window') }}
          </p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.contextWindowHint') }}</p>
        </div>
        <div>
          <label class="input-label" :for="`${uid}-compact`">{{ t('admin.claudexModels.editor.autoCompact') }}</label>
          <input
            :id="`${uid}-compact`"
            v-model="form.auto_compact_tokens"
            type="number"
            min="1"
            step="1"
            class="input"
            :class="{ 'input-error': visibleProblem('auto_compact_tokens') }"
            :placeholder="t('admin.claudexModels.editor.notSet')"
            data-testid="claudex-model-auto-compact"
          />
          <p
            v-if="visibleProblem('auto_compact_tokens')"
            class="input-error-text mt-1.5"
            data-testid="claudex-model-error-auto_compact_tokens"
          >
            {{ problemText('auto_compact_tokens') }}
          </p>
          <p v-else class="input-hint mt-1.5">{{ t('admin.claudexModels.editor.autoCompactHint') }}</p>
        </div>
      </div>

      <p class="text-xs text-gray-500 dark:text-gray-400" data-testid="claudex-model-pricing-note">
        {{ t('admin.claudexModels.editor.pricingNote') }}
        <RouterLink to="/admin/channels/pricing" class="text-primary-600 hover:underline dark:text-primary-400">
          {{ t('admin.claudexModels.editor.pricingLink') }}
        </RouterLink>
      </p>
    </form>

    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-3">
        <p
          v-if="save.error.value"
          role="alert"
          class="basis-full text-sm text-red-600 dark:text-red-400 sm:mr-auto sm:basis-auto"
          data-testid="claudex-model-save-error"
        >
          {{ save.error.value }}
        </p>
        <p
          v-else-if="attempted && hasProblems"
          role="alert"
          class="basis-full text-sm text-red-600 dark:text-red-400 sm:mr-auto sm:basis-auto"
          data-testid="claudex-model-form-invalid"
        >
          {{ t('admin.claudexModels.editor.fixProblems') }}
        </p>
        <button type="button" class="btn btn-secondary" :disabled="save.saving.value" @click="close">
          {{ t('admin.claudexModels.editor.cancel') }}
        </button>
        <button
          type="submit"
          form="claudex-model-form"
          class="btn btn-primary"
          :disabled="save.saving.value"
          data-testid="claudex-model-save"
        >
          {{ save.saving.value ? t('admin.claudex.common.saving') : t('admin.claudex.common.save') }}
        </button>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import Select from '@/components/common/Select.vue'
import TagInput from '@/components/admin/claudex/common/TagInput.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import type { StepUpController } from '@/composables/useStepUp'
import { adminAPI } from '@/api/admin'
import {
  CLAUDEX_MODEL_EFFORTS,
  type ClaudexModelCandidates,
  type ClaudexModelEffort,
  type ClaudexModelMeta
} from '@/api/admin/claudex/models'
import type { AdminGroup } from '@/types'
import { extractApiErrorMetadata } from '@/utils/apiError'
import {
  BADGES_MAX,
  badgeProblemKey,
  effortsAboveCeiling,
  effortsInOrder,
  emptyModelMetaForm,
  fieldFromServer,
  formFromRow,
  toModelMetaInput,
  validateModelMetaForm,
  type ModelMetaField,
  type ModelMetaForm,
  type ModelMetaProblems
} from './modelMetaForm'

const props = withDefaults(
  defineProps<{
    show: boolean
    /** The entry to edit; null adds a new one. */
    row?: ClaudexModelMeta | null
    groups?: AdminGroup[]
    /** Scope a new entry starts with (null = global). */
    defaultGroupId?: number | null
    /** The page's step-up controller: catalog writes need step-up (R13). */
    stepUp?: StepUpController | null
  }>(),
  { row: null, groups: () => [], defaultGroupId: null, stepUp: null }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', row: ClaudexModelMeta): void
  /** The catalog changed on the server (entry gone, or a conflicting entry); the page should reload. */
  (e: 'stale'): void
}>()

const { t } = useI18n()
const uid = `claudex-model-${useId()}`
const save = useClaudexSave('claudexModels')

const form = reactive<ModelMetaForm>(emptyModelMetaForm())
const attempted = ref(false)
const serverProblems = ref<ModelMetaProblems>({})

const isEditing = computed(() => props.row !== null)
const groupIds = computed(() => new Set(props.groups.map((group) => group.id)))
const selectedGroup = computed(() =>
  form.group_id === null ? null : (props.groups.find((group) => group.id === form.group_id) ?? null)
)

const scopeOptions = computed(() => {
  const options: Array<{ value: string | number; label: string }> = [
    { value: 'global', label: t('admin.claudexModels.scopeGlobal') },
    ...props.groups.map((group) => ({
      value: group.id,
      label: group.status === 'active' ? group.name : t('admin.claudexModels.groupInactive', { name: group.name })
    }))
  ]
  // An entry of a group that is no longer listed (e.g. deleted) still shows its scope.
  const row = props.row
  if (row && row.group_id !== null && !groupIds.value.has(row.group_id)) {
    options.push({ value: row.group_id, label: scopeLabelOfRow(row) })
  }
  return options
})

function scopeLabelOfRow(row: ClaudexModelMeta): string {
  const name = row.group_name || t('admin.claudexModels.groupFallback', { id: row.group_id })
  return row.group_deleted ? t('admin.claudexModels.groupDeleted', { name }) : name
}

const scopeValue = computed<string | number>({
  get: () => (form.group_id === null ? 'global' : form.group_id),
  set: (value) => {
    form.group_id = value === 'global' || value === null || value === '' ? null : Number(value)
  }
})

const defaultEffortOptions = computed(() => [
  { value: '', label: t('admin.claudexModels.editor.defaultEffortNone') },
  ...form.supported_efforts.map((effort) => ({ value: effort, label: effort }))
])

// Scope and model of an existing entry cannot change, so only a new entry's group is checked.
const problems = computed(() => validateModelMetaForm(form, isEditing.value ? undefined : groupIds.value))
const hasProblems = computed(() => Object.keys(problems.value).length > 0)

function visibleProblem(field: ModelMetaField) {
  return (attempted.value ? problems.value[field] : undefined) ?? serverProblems.value[field]
}

function problemText(field: ModelMetaField): string {
  const problem = visibleProblem(field)
  return problem ? t(problem.key, problem.params ?? {}) : ''
}

const effortsCut = computed(() =>
  form.efforts_known ? effortsAboveCeiling(form.supported_efforts, selectedGroup.value?.max_reasoning_effort) : []
)

function setEffortsKnown(known: boolean) {
  form.efforts_known = known
  if (!known) form.default_effort = ''
}

function toggleEffort(effort: ClaudexModelEffort, checked: boolean) {
  const next = checked
    ? effortsInOrder([...form.supported_efforts, effort])
    : form.supported_efforts.filter((value) => value !== effort)
  form.supported_efforts = next
  if (form.default_effort && !next.includes(form.default_effort)) form.default_effort = ''
}

// ----- Candidates -----
const candidates = ref<ClaudexModelCandidates | null>(null)
const candidatesLoading = ref(false)
const candidatesFailed = ref(false)
let candidatesController: AbortController | null = null

const candidateModels = computed(() => candidates.value?.models ?? [])
const candidateSet = computed(() => new Set(candidateModels.value))

const candidatesStatus = computed(() => {
  if (candidatesLoading.value) return t('admin.claudexModels.editor.candidatesLoading')
  if (candidatesFailed.value) return t('admin.claudexModels.editor.candidatesFailed')
  if (!candidates.value) return ''
  if (candidateModels.value.length === 0) return t('admin.claudexModels.editor.candidatesNone')
  return t('admin.claudexModels.editor.candidatesCount', { count: candidateModels.value.length })
})

const notInCandidates = computed(() => {
  const id = form.model_id.trim()
  return !!id && !!candidates.value && !candidatesLoading.value && !candidateSet.value.has(id)
})

function sourceLabel(model: string): string {
  const sources = candidates.value?.sources?.[model] ?? []
  return sources
    .map((source) => {
      switch (source) {
        case 'allowlist':
          return t('admin.claudexModels.sources.allowlist')
        case 'default_mapped_model':
          return t('admin.claudexModels.sources.defaultMappedModel')
        case 'channel_pricing':
          return t('admin.claudexModels.sources.channelPricing')
        case 'channel_mapping':
          return t('admin.claudexModels.sources.channelMapping')
        case 'group_pricing':
          return t('admin.claudexModels.sources.groupPricing')
        default:
          return source
      }
    })
    .join(', ')
}

/** Scope the candidates were last requested for (undefined = none yet). */
let candidatesGroup: number | null | undefined

async function loadCandidates(groupId: number | null) {
  candidatesController?.abort()
  const controller = new AbortController()
  candidatesController = controller
  candidatesGroup = groupId
  candidatesLoading.value = true
  candidatesFailed.value = false
  try {
    const result = await adminAPI.claudex.models.candidates(groupId, { signal: controller.signal })
    if (candidatesController !== controller) return
    candidates.value = result
  } catch {
    if (candidatesController !== controller) return
    candidates.value = null
    candidatesFailed.value = true
  } finally {
    if (candidatesController === controller) {
      candidatesLoading.value = false
      candidatesController = null
    }
  }
}

function stopCandidates() {
  candidatesController?.abort()
  candidatesController = null
  candidatesGroup = undefined
  candidatesLoading.value = false
}

// ----- Open / close / save -----
function reset() {
  stopCandidates()
  Object.assign(form, props.row ? formFromRow(props.row) : emptyModelMetaForm(props.defaultGroupId ?? null))
  attempted.value = false
  serverProblems.value = {}
  save.reset()
  candidates.value = null
  candidatesFailed.value = false
}

watch(
  () => props.show,
  (open) => {
    if (open) reset()
    else stopCandidates()
  },
  { immediate: true }
)

// Suggestions follow the scope: opening the dialog or picking another group loads them.
watch(
  [() => props.show, () => form.group_id],
  ([open, groupId]) => {
    if (open && groupId !== candidatesGroup) void loadCandidates(groupId)
  },
  { immediate: true }
)

// A value the server rejected stops being marked once the form changes.
watch(form, () => {
  if (Object.keys(serverProblems.value).length > 0) serverProblems.value = {}
})

function close() {
  if (save.saving.value) return
  emit('close')
}

async function submit() {
  if (save.saving.value) return
  attempted.value = true
  serverProblems.value = {}
  if (hasProblems.value) return
  const body = toModelMetaInput(form)
  const editing = props.row
  const write = () =>
    editing ? adminAPI.claudex.models.update(editing.id, body) : adminAPI.claudex.models.create(body)
  const stepUp = props.stepUp
  const result = await save.run(() => (stepUp ? runWithStepUp(stepUp, write, t) : write()))
  if (result.ok) {
    emit('saved', result.value)
    return
  }
  const reason = save.reason.value
  if (reason === 'CLAUDEX_MODEL_META_INVALID') {
    const field = fieldFromServer(extractApiErrorMetadata(save.lastError.value)?.field)
    if (field) serverProblems.value = { [field]: { key: 'admin.claudexModels.validation.server' } }
  } else if (
    reason === 'CLAUDEX_MODEL_META_NOT_FOUND' ||
    reason === 'CLAUDEX_MODEL_META_CONFLICT' ||
    reason === 'CLAUDEX_GROUP_NOT_FOUND'
  ) {
    // Someone else changed the catalog or the groups: let the page show what the server has now.
    emit('stale')
  }
}

onBeforeUnmount(stopCandidates)
</script>
