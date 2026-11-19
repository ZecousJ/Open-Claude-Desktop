<template>
  <ClaudexPageShell :title="t('admin.claudex.directory.title')" :description="t('admin.claudex.directory.description')" :loading="loading" :load-error="error" @retry="load">
    <div v-if="!loading" class="space-y-4">
      <p v-if="reviewError" role="alert" class="text-sm text-red-700 dark:text-red-300">{{ reviewError }}</p>
      <div v-for="row in rows" :key="row.id" class="card p-5">
        <div class="flex items-start justify-between gap-4">
          <div><h3 class="font-semibold">{{ row.name }}</h3><p class="text-sm text-gray-500">{{ row.kind }} · {{ row.email }} · {{ row.url }}</p><p class="mt-2 text-sm">{{ row.description }}</p><p class="mt-2 whitespace-pre-wrap break-words text-sm">{{ row.examples }}</p><p class="mt-2 text-sm">{{ row.license }}</p><p v-if="row.tools?.length" class="mt-2 break-words text-sm">{{ row.tools.join(', ') }}</p></div>
          <span class="text-sm">{{ t(`admin.claudex.directory.status.${row.publishedAt ? 'published' : row.status}`) }}</span>
        </div>
        <dl v-if="row.original || row.serverUrlType" class="mt-4 space-y-3 text-sm">
          <div v-if="row.serverUrlType && row.serverUrlType !== 'universal'">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.endpoints') }}</dt>
            <dd v-for="option in row.remoteUrlOptions" :key="option.url" class="break-all">{{ option.label ? `${option.label} · ${option.url}` : option.url }}</dd>
            <dd v-if="row.remoteUrlRegex || row.remoteUrlTemplate" class="break-all"><code>{{ row.remoteUrlRegex || row.remoteUrlTemplate }}</code></dd>
            <dd v-if="row.remoteUserConfig" class="break-words">{{ row.remoteUserConfig.title }} · {{ row.remoteUserConfig.description }} · <code>{{ row.remoteUserConfig.pattern }}</code></dd>
          </div>
          <div v-if="row.testServerUrl">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.testUrl') }}</dt>
            <dd class="break-all">{{ row.testServerUrl }}</dd>
          </div>
          <div v-if="row.original?.submission_data?.test_setup_instructions">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.testSetup') }}</dt>
            <dd class="whitespace-pre-wrap break-words">{{ row.original.submission_data.test_setup_instructions }}</dd>
          </div>
          <div v-if="row.original?.submission_data?.test_data_availability">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.testData') }}</dt>
            <dd class="whitespace-pre-wrap break-words">{{ row.original.submission_data.test_data_availability }}</dd>
          </div>
          <div v-if="row.original?.submission_data?.policy_compliance">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.policies') }}</dt>
            <dd v-for="key in policyKeys.filter(key => typeof row.original?.submission_data?.policy_compliance?.[key] === 'boolean')" :key="key">
              {{ t(`admin.claudex.directory.policies.${key}`) }} · {{ t(`admin.claudex.directory.reviewFields.${row.original.submission_data.policy_compliance[key] ? 'confirmed' : 'unconfirmed'}`) }}
            </dd>
          </div>
          <div v-if="Array.isArray(row.original?.supported_platforms) && row.original.supported_platforms.length">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.platforms') }}</dt>
            <dd>{{ row.original.supported_platforms.map(platform => t(`admin.claudex.directory.platforms.${platform}`)).join(', ') }}</dd>
          </div>
          <div v-if="typeof row.original?.collects_user_data === 'boolean'">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.collectsData') }}</dt>
            <dd>{{ t(`admin.claudex.directory.reviewFields.${row.original.collects_user_data ? 'yes' : 'no'}`) }}</dd>
          </div>
          <div v-if="row.original?.privacy_policy_url">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.privacy') }}</dt>
            <dd class="break-all">{{ row.original.privacy_policy_url }}</dd>
          </div>
          <div v-if="row.original?.terms_of_service_url">
            <dt class="font-medium">{{ t('admin.claudex.directory.reviewFields.terms') }}</dt>
            <dd class="break-all">{{ row.original.terms_of_service_url }}</dd>
          </div>
        </dl>
        <label class="input-label mt-4 block" :for="`notes-${row.id}`">{{ t('admin.claudex.directory.notes') }}</label>
        <textarea :id="`notes-${row.id}`" v-model="notes[row.id]" :readonly="awaitsAuthor(row)" class="input mt-2 w-full" rows="3" maxlength="10000" />
        <div v-if="!awaitsAuthor(row)" class="mt-3 flex gap-2"><button class="btn btn-secondary" :disabled="busy" @click="review(row, 'in_review')">{{ t('admin.claudex.directory.status.in_review') }}</button><button class="btn btn-primary" :disabled="busy" @click="review(row, 'approved')">{{ t('admin.claudex.directory.approve') }}</button><button class="btn btn-danger" :disabled="busy" @click="review(row, 'rejected')">{{ t('admin.claudex.directory.reject') }}</button></div>
      </div>
      <p v-if="!rows.length">{{ t('admin.claudex.directory.empty') }}</p>
    </div>
  </ClaudexPageShell>
  <TotpStepUpDialog :controller="stepUp" />
</template>
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import { directory, type DirectorySubmission } from '@/api/admin/claudex/directory'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import { isStepUpCancelled, useStepUp } from '@/composables/useStepUp'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import { extractApiErrorCode } from '@/utils/apiError'
const { t } = useI18n()
const policyKeys = [
  'readGuidelines', 'firstPartyApi', 'noFinancialTransactions', 'noAiMediaGeneration',
  'noPromptInjection', 'noConversationDataCollection', 'publicDocsByPublishDate'
]
const rows = ref<DirectorySubmission[]>([])
const notes = reactive<Record<string, string>>({})
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const reviewError = ref<string | null>(null)
const stepUp = useStepUp()
function awaitsAuthor(row: DirectorySubmission) {
  return row.original !== undefined && row.status === 'rejected'
}
async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = (await directory.list()).data
    for (const row of rows.value) notes[row.id] = row.reviewerNote
  } catch (e) {
    error.value = t('admin.claudex.common.loadFailed')
  } finally {
    loading.value = false
  }
}
async function review(row: DirectorySubmission, status: string) {
  if (busy.value) return
  busy.value = true
  reviewError.value = null
  try {
    await runWithStepUp(stepUp, () => directory.review(row.id, {
      status,
      note: notes[row.id] ?? '',
      expectedUpdatedAt: row.updatedAt
    }), t)
    await load()
  } catch (e) {
    if (extractApiErrorCode(e) === 'DIRECTORY_SUBMISSION_CHANGED') {
      await load()
      reviewError.value = t('admin.claudex.directory.reviewChanged')
    } else if (!isStepUpCancelled(e)) {
      reviewError.value = t('admin.claudex.common.saveFailed')
    }
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>
