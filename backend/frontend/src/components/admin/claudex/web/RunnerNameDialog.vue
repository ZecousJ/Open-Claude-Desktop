<!--
  CLAUDEX: name a runner. "create" adds a runner (POST /admin/claudex/web/runners,
  step-up) and then shows its token once, so it can be copied into the
  runner's configuration; the server keeps only a hash and can never show it
  again. "rename" changes the name of a stored runner (PATCH, step-up).
-->
<template>
  <BaseDialog :show="show" :title="title" width="normal" @close="close">
    <div v-if="created" class="space-y-4" data-testid="claudex-web-runner-created">
      <p class="text-sm text-gray-700 dark:text-gray-300">
        {{ t('admin.claudexWeb.runners.create.createdFor', { name: created.runner.name }) }}
      </p>
      <div>
        <label :for="`${uid}-token`" class="input-label">{{ t('admin.claudexWeb.runners.create.token') }}</label>
        <div class="mt-1.5 flex gap-2">
          <input
            :id="`${uid}-token`"
            :value="created.token"
            type="text"
            readonly
            autocomplete="off"
            spellcheck="false"
            class="input w-full font-mono text-sm"
            data-testid="claudex-web-runner-token"
            @focus="selectAll"
          />
          <button
            type="button"
            class="btn btn-secondary shrink-0"
            data-testid="claudex-web-runner-token-copy"
            @click="copyToken"
          >
            {{ copied ? t('admin.claudexWeb.runners.create.copied') : t('admin.claudexWeb.runners.create.copy') }}
          </button>
        </div>
      </div>
      <p
        role="note"
        class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200"
      >
        {{ t('admin.claudexWeb.runners.create.onceNotice') }}
      </p>
    </div>

    <form
      v-else
      :id="`${uid}-form`"
      class="space-y-4"
      novalidate
      data-testid="claudex-web-runner-form"
      @submit.prevent="submit"
    >
      <div>
        <label :for="`${uid}-name`" class="input-label">{{ t('admin.claudexWeb.runners.name') }}</label>
        <input
          :id="`${uid}-name`"
          v-model="name"
          type="text"
          maxlength="100"
          autocomplete="off"
          class="input mt-1.5 w-full"
          :class="{ 'input-error': shownProblem }"
          :placeholder="t('admin.claudexWeb.runners.create.namePlaceholder')"
          data-testid="claudex-web-runner-name"
        />
        <p v-if="shownProblem" class="input-error-text mt-1.5">{{ t(shownProblem) }}</p>
        <p v-else-if="mode === 'create'" class="input-hint mt-1.5">{{ t('admin.claudexWeb.runners.create.nameHint') }}</p>
      </div>

      <p v-if="action.error.value" role="alert" class="text-sm text-red-600 dark:text-red-400" data-testid="claudex-web-runner-error">
        {{ action.error.value }}
      </p>
    </form>

    <template #footer>
      <div class="flex justify-end gap-2">
        <template v-if="created">
          <button type="button" class="btn btn-primary" data-testid="claudex-web-runner-done" @click="close">
            {{ t('admin.claudexWeb.runners.create.done') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-secondary" :disabled="action.saving.value" @click="close">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            :form="`${uid}-form`"
            class="btn btn-primary"
            :disabled="action.saving.value"
            data-testid="claudex-web-runner-submit"
          >
            {{ action.saving.value ? t('admin.claudex.common.saving') : submitLabel }}
          </button>
        </template>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import { useClipboard } from '@/composables/useClipboard'
import type { StepUpController } from '@/composables/useStepUp'
import { createRunner, updateRunner, type CreatedRunner } from '@/api/admin/claudex/web'
import { cleanRunnerName, runnerNameProblem } from './webForm'

const props = defineProps<{
  show: boolean
  mode: 'create' | 'rename'
  /** The stored runner being renamed (record id and current name). */
  runner?: { recordId: number; name: string } | null
  stepUp: StepUpController
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', runner: CreatedRunner['runner']): void
  (e: 'renamed'): void
}>()

const { t } = useI18n()
const uid = `claudex-web-runner-${useId()}`
const action = useClaudexSave('claudexWeb')
const { copied, copyToClipboard } = useClipboard()

const name = ref('')
const attempted = ref(false)
const created = ref<CreatedRunner | null>(null)

const title = computed(() =>
  props.mode === 'create' ? t('admin.claudexWeb.runners.create.title') : t('admin.claudexWeb.runners.rename.title')
)
const submitLabel = computed(() =>
  props.mode === 'create' ? t('admin.claudexWeb.runners.create.submit') : t('admin.claudexWeb.runners.rename.submit')
)
const problem = computed(() => runnerNameProblem(name.value))
const shownProblem = computed(() => (attempted.value ? problem.value : null))

watch(
  () => [props.show, props.mode, props.runner?.recordId] as const,
  ([show]) => {
    if (!show) return
    name.value = props.mode === 'rename' ? (props.runner?.name ?? '') : ''
    attempted.value = false
    created.value = null
    action.reset()
  },
  { immediate: true }
)

function close() {
  if (action.saving.value) return
  // The token is dropped with the dialog: it is never shown again.
  created.value = null
  emit('close')
}

async function submit() {
  attempted.value = true
  if (action.saving.value || problem.value) return
  const clean = cleanRunnerName(name.value)
  if (props.mode === 'create') {
    const result = await action.run(() => runWithStepUp(props.stepUp, () => createRunner(clean), t))
    if (result.ok) {
      created.value = result.value
      emit('created', result.value.runner)
    }
    return
  }
  const recordId = props.runner?.recordId
  if (!recordId) return
  const result = await action.run(() => runWithStepUp(props.stepUp, () => updateRunner(recordId, { name: clean }), t))
  if (result.ok) {
    emit('renamed')
    emit('close')
  }
}

function selectAll(event: FocusEvent) {
  const input = event.target as HTMLInputElement | null
  input?.select()
}

async function copyToken() {
  if (created.value) await copyToClipboard(created.value.token, t('admin.claudexWeb.runners.create.copiedToast'))
}
</script>
