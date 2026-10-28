<!--
  CLAUDEX: a user's first-run onboarding answers in the user dialog
  (GET /admin/claudex/onboarding/users/:id; backend internal/claudex/onboarding).
  Read only. Accounts made before the onboarding have no answers.
-->
<template>
  <div data-testid="claudex-user-onboarding">
    <label class="input-label">{{ t('admin.claudexOnboarding.title') }}</label>
    <p v-if="loading" class="text-sm text-gray-500 dark:text-gray-400">
      {{ t('admin.claudex.common.loading') }}
    </p>
    <p v-else-if="error" role="alert" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    <p v-else-if="!data?.found" class="text-sm text-gray-500 dark:text-gray-400">
      {{ t('admin.claudexOnboarding.none') }}
    </p>
    <dl v-else class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexOnboarding.status') }}</dt>
      <dd class="text-gray-900 dark:text-white">
        {{
          data.finished_at
            ? t('admin.claudexOnboarding.finished', { time: formatDateTime(data.finished_at) })
            : t('admin.claudexOnboarding.pending')
        }}
      </dd>
      <template v-for="row in rows" :key="row.key">
        <dt class="text-gray-500 dark:text-gray-400">{{ t(`admin.claudexOnboarding.${row.key}`) }}</dt>
        <dd class="break-words text-gray-900 dark:text-white">{{ row.value || '—' }}</dd>
      </template>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getUser, type UserOnboarding } from '@/api/admin/claudex/onboarding'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{ userId: number | null | undefined }>()
const { t, te } = useI18n()
const data = ref<UserOnboarding | null>(null)
const loading = ref(false)
const error = ref('')

const rows = computed(() => {
  const a = data.value?.answers
  if (!a) return []
  const heard = [a.hear_about, a.hear_about_platform, a.hear_about_other].filter(Boolean).join(' · ')
  return [
    { key: 'workFunction', value: a.work_function },
    { key: 'hearAbout', value: heard },
    { key: 'codeSetup', value: a.code_setup },
    { key: 'connectedTools', value: (a.connected_tools ?? []).join(', ') },
    { key: 'firstTask', value: a.first_task }
  ]
})

watch(
  () => props.userId,
  async (id) => {
    data.value = null
    error.value = ''
    if (!id) return
    loading.value = true
    try {
      const answer = await getUser(id)
      if (props.userId === id) data.value = answer
    } catch (e) {
      if (props.userId === id) error.value = claudexErrorMessage(e, t, te, 'claudexOnboarding', t('admin.claudexOnboarding.loadFailed'))
    } finally {
      if (props.userId === id) loading.value = false
    }
  },
  { immediate: true }
)
</script>
