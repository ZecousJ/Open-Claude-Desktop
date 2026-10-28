<template>
  <ClaudexPageShell :title="t('admin.claudex.directory.title')" :description="t('admin.claudex.directory.description')" :loading="loading" :load-error="error" @retry="load">
    <div v-if="!loading" class="space-y-4">
      <div v-for="row in rows" :key="row.id" class="card p-5">
        <div class="flex items-start justify-between gap-4">
          <div><h3 class="font-semibold">{{ row.name }}</h3><p class="text-sm text-gray-500">{{ row.kind }} · {{ row.email }} · {{ row.url }}</p><p class="mt-2 text-sm">{{ row.description }}</p><p class="mt-2 whitespace-pre-wrap break-words text-sm">{{ row.examples }}</p><p class="mt-2 text-sm">{{ row.license }}</p><p v-if="row.tools?.length" class="mt-2 break-words text-sm">{{ row.tools.join(', ') }}</p></div>
          <span class="text-sm">{{ t(`admin.claudex.directory.status.${row.status}`) }}</span>
        </div>
        <label class="input-label mt-4 block" :for="`notes-${row.id}`">{{ t('admin.claudex.directory.notes') }}</label>
        <textarea :id="`notes-${row.id}`" v-model="notes[row.id]" class="input mt-2 w-full" rows="3" maxlength="10000" />
        <div class="mt-3 flex gap-2"><button class="btn btn-secondary" :disabled="busy" @click="review(row, 'in_review')">{{ t('admin.claudex.directory.status.in_review') }}</button><button class="btn btn-primary" :disabled="busy" @click="review(row, 'approved')">{{ t('admin.claudex.directory.approve') }}</button><button class="btn btn-danger" :disabled="busy" @click="review(row, 'rejected')">{{ t('admin.claudex.directory.reject') }}</button></div>
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
const { t } = useI18n()
const rows = ref<DirectorySubmission[]>([])
const notes = reactive<Record<string, string>>({})
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const stepUp = useStepUp()
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
  error.value = null
  try {
    await runWithStepUp(stepUp, () => directory.review(row.id, status, notes[row.id] ?? ''), t)
    await load()
  } catch (e) {
    if (!isStepUpCancelled(e)) error.value = t('admin.claudex.common.saveFailed')
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>
