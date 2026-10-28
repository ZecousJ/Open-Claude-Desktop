<!--
  CLAUDEX: the catalog by group (/admin/claudex/models, top card). Each active
  group lists every model its key gets (/v1/models) and where the desktop app
  shows it: the main menu, More models, or nowhere. The group may pick its
  default model; without one (or when it is hidden or no longer offered) the
  first of the main menu is the default. A user who switches
  group in the app's API page sees that group's models.
-->
<template>
  <div class="card overflow-hidden" data-testid="claudex-group-models">
    <div class="flex flex-wrap items-center gap-3 border-b border-gray-100 p-4 dark:border-dark-700">
      <div class="mr-auto min-w-0">
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexModels.groups.title') }}</h3>
        <p class="mt-0.5 text-sm text-gray-500 dark:text-dark-400">{{ t('admin.claudexModels.groups.description') }}</p>
      </div>
      <div class="w-full sm:w-64">
        <Select
          v-model="groupId"
          :options="groupOptions"
          :aria-label="t('admin.claudexModels.groups.group')"
          :placeholder="t('admin.claudexModels.groups.group')"
          data-testid="claudex-group-models-select"
          @change="onGroupChange"
        />
      </div>
    </div>

    <div v-if="loadError" class="flex items-center justify-between gap-3 p-4 text-sm text-red-600 dark:text-red-400">
      <span>{{ loadError }}</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('admin.claudexModels.refresh') }}</button>
    </div>
    <div v-else-if="loading && !current" class="p-6 text-center text-sm text-gray-500 dark:text-dark-400">
      {{ t('admin.claudexModels.groups.loading') }}
    </div>
    <div v-else-if="!current" class="p-6 text-center text-sm text-gray-500 dark:text-dark-400">
      {{ t('admin.claudexModels.groups.noGroups') }}
    </div>
    <template v-else>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-dark-800 dark:text-dark-400">
            <tr>
              <th class="px-4 py-3 font-medium">{{ t('admin.claudexModels.columns.model') }}</th>
              <th class="px-4 py-3 font-medium">{{ t('admin.claudexModels.groups.placement') }}</th>
              <th class="w-32 px-4 py-3 font-medium">{{ t('admin.claudexModels.columns.sort') }}</th>
              <th class="w-20 px-4 py-3 text-center font-medium">{{ t('admin.claudexModels.columns.default') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-dark-700">
            <tr v-if="draft.length === 0">
              <td colspan="4" class="px-4 py-6 text-center text-gray-500 dark:text-dark-400">
                {{ t('admin.claudexModels.groups.empty') }}
              </td>
            </tr>
            <tr v-for="(model, index) in draft" :key="model.model_id">
              <td class="px-4 py-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-gray-900 dark:text-white">{{ model.model_id }}</span>
                  <span
                    v-if="index === defaultIndex"
                    class="badge badge-success"
                    :title="
                      chosenDefault ? t('admin.claudexModels.groups.defaultChosenHint') : t('admin.claudexModels.groups.defaultHint')
                    "
                    >{{
                      chosenDefault ? t('admin.claudexModels.defaultYes') : t('admin.claudexModels.groups.defaultAuto')
                    }}</span
                  >
                </div>
                <div
                  v-if="model.display_name && model.display_name !== model.model_id"
                  class="mt-0.5 text-xs text-gray-500 dark:text-dark-400"
                >
                  {{ model.display_name }}
                </div>
              </td>
              <td class="px-4 py-3">
                <div
                  class="inline-flex overflow-hidden rounded-lg border border-gray-200 dark:border-dark-600"
                  role="radiogroup"
                  :aria-label="t('admin.claudexModels.groups.placement')"
                >
                  <button
                    v-for="option in placements"
                    :key="option"
                    type="button"
                    role="radio"
                    :aria-checked="model.placement === option"
                    class="px-3 py-1.5 text-xs font-medium transition-colors"
                    :class="
                      model.placement === option
                        ? 'bg-primary-500 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-dark-800 dark:text-gray-300 dark:hover:bg-dark-700'
                    "
                    :data-testid="`claudex-group-models-${option}`"
                    @click="setPlacement(model, option)"
                  >
                    {{ t(`admin.claudexModels.groups.placements.${option}`) }}
                  </button>
                </div>
              </td>
              <td class="px-4 py-3">
                <input
                  v-model="model.sortText"
                  type="number"
                  step="1"
                  class="input h-8 w-24 py-1 text-sm"
                  :placeholder="String(model.order)"
                  :aria-label="t('admin.claudexModels.columns.sort')"
                />
              </td>
              <td class="px-4 py-3 text-center">
                <input
                  type="radio"
                  class="h-4 w-4 cursor-pointer accent-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
                  :name="`claudex-default-${groupId}`"
                  :checked="model.is_default"
                  :disabled="model.placement === 'hidden'"
                  :title="t('admin.claudexModels.groups.defaultPick')"
                  :aria-label="t('admin.claudexModels.groups.defaultPick')"
                  data-testid="claudex-group-models-default"
                  @click="toggleDefault(model)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 p-4 dark:border-dark-700">
        <span v-if="dirty" class="mr-auto text-sm text-amber-600 dark:text-amber-400">{{
          t('admin.claudexModels.groups.unsaved')
        }}</span>
        <button type="button" class="btn btn-secondary" :disabled="!dirty || saving" @click="reset">
          {{ t('admin.claudexModels.groups.reset') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!dirty || saving"
          data-testid="claudex-group-models-save"
          @click="save"
        >
          {{ saving ? t('admin.claudexModels.groups.saving') : t('admin.claudexModels.groups.save') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import Select from '@/components/common/Select.vue'
import { adminAPI } from '@/api/admin'
import type {
  ClaudexGroupModel,
  ClaudexGroupModels,
  ClaudexModelPlacement,
  ClaudexPlacementInput
} from '@/api/admin/claudex/models'
import { isStepUpCancelled, type StepUpController } from '@/composables/useStepUp'
import { useAppStore } from '@/stores/app'

const props = defineProps<{ stepUp: StepUpController }>()

const { t, te } = useI18n()
const appStore = useAppStore()

const placements: ClaudexModelPlacement[] = ['main', 'more', 'hidden']

interface DraftModel extends ClaudexGroupModel {
  /** The order field as typed ('' = the description's order). */
  sortText: string
}

const groupList = ref<ClaudexGroupModels[]>([])
const groupId = ref<number | null>(null)
const draft = ref<DraftModel[]>([])
const loading = ref(false)
const saving = ref(false)
const loadError = ref<string | null>(null)

const current = computed(() => groupList.value.find((group) => group.id === groupId.value) ?? null)

const groupOptions = computed(() =>
  groupList.value.map((group) => ({
    value: group.id,
    label: t('admin.claudexModels.groups.option', { name: group.name, count: offered(group.models).length })
  }))
)

/** What the group's key gets now; a model it no longer gets is not shown. */
function offered(models: ClaudexGroupModel[]): ClaudexGroupModel[] {
  return models.filter((model) => model.listed)
}

function toDraft(models: ClaudexGroupModel[]): DraftModel[] {
  return offered(models).map((model) => ({ ...model, sortText: model.sort_order === null ? '' : String(model.sort_order) }))
}

function sortOf(model: DraftModel): number | null {
  const text = String(model.sortText ?? '').trim()
  if (text === '') return null
  const value = Number(text)
  return Number.isInteger(value) ? value : null
}

/** The group's own default, while it is not hidden. */
const chosenDefault = computed(() => draft.value.some((model) => model.is_default && model.placement !== 'hidden'))

function setPlacement(model: DraftModel, placement: ClaudexModelPlacement) {
  model.placement = placement
  // A hidden model cannot be the default; the next in order takes over.
  if (placement === 'hidden') model.is_default = false
}

/** Picks the model as the default; picking the chosen one again goes back to automatic. */
function toggleDefault(model: DraftModel) {
  const next = !model.is_default
  for (const other of draft.value) other.is_default = false
  model.is_default = next
}

/** The app's default: the group's chosen one, else the first model of the main menu in menu order. */
const defaultIndex = computed(() => {
  const chosen = draft.value.findIndex((model) => model.is_default && model.placement !== 'hidden')
  if (chosen >= 0) return chosen
  let best = -1
  let bestOrder = Infinity
  draft.value.forEach((model, index) => {
    if (model.placement !== 'main') return
    const order = sortOf(model) ?? model.order
    if (order < bestOrder) {
      best = index
      bestOrder = order
    }
  })
  return best
})

const dirty = computed(() => {
  const saved = offered(current.value?.models ?? [])
  return draft.value.some((model, index) => {
    const before = saved[index]
    return (
      !before ||
      before.placement !== model.placement ||
      before.sort_order !== sortOf(model) ||
      before.is_default !== model.is_default
    )
  })
})

function reset() {
  draft.value = toDraft(current.value?.models ?? [])
}

function onGroupChange() {
  reset()
}

async function load() {
  loading.value = true
  try {
    groupList.value = await adminAPI.claudex.models.groups()
    if (!groupList.value.some((group) => group.id === groupId.value)) {
      groupId.value = groupList.value[0]?.id ?? null
    }
    reset()
    loadError.value = null
  } catch (err) {
    loadError.value = claudexErrorMessage(err, t, te, 'claudexModels', t('admin.claudexModels.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function save() {
  const group = current.value
  if (!group || saving.value) return
  const saved = new Map(group.models.map((model) => [model.model_id, model]))
  // Keep every configured placement of an offered model; add the ones
  // changed here. A placement of a model the group no longer offers is
  // dropped (the list replaces the group's placements).
  const items: ClaudexPlacementInput[] = draft.value
    .filter((model) => {
      const before = saved.get(model.model_id)
      return (
        model.configured ||
        model.is_default ||
        !before ||
        before.placement !== model.placement ||
        before.sort_order !== sortOf(model)
      )
    })
    .map((model) => ({
      model_id: model.model_id,
      placement: model.placement,
      sort_order: sortOf(model),
      is_default: model.is_default && model.placement !== 'hidden'
    }))
  saving.value = true
  try {
    const next = await runWithStepUp(props.stepUp, () => adminAPI.claudex.models.setPlacements(group.id, items), t)
    groupList.value = groupList.value.map((item) => (item.id === group.id ? next : item))
    reset()
    appStore.showSuccess(t('admin.claudexModels.saved'))
  } catch (err) {
    if (!isStepUpCancelled(err)) {
      appStore.showError(claudexErrorMessage(err, t, te, 'claudexModels', t('admin.claudex.common.saveFailed')))
    }
  } finally {
    saving.value = false
  }
}

defineExpose({ load })

onMounted(load)
</script>
