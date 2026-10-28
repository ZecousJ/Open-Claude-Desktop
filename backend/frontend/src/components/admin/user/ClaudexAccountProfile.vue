<!--
  CLAUDEX: sign-up profile (owner, 2026-10-12). The user detail shows what the
  user gave in the account step after sign-up (internal/claudex/profile):
  the name Claudex calls them, their birthday and the Terms of Service
  version they accepted. Read-only; the user changes them in the apps.
-->
<template>
  <div class="rounded-lg border border-gray-200 p-3 dark:border-dark-600" data-testid="claudex-account-profile">
    <div class="mb-2 flex items-center justify-between">
      <span class="input-label !mb-0">{{ t('admin.claudexAccountProfile.title') }}</span>
      <a href="/legal/terms" target="_blank" rel="noopener" class="text-xs text-primary-600 hover:underline dark:text-primary-400">
        {{ t('admin.claudexAccountProfile.viewTerms') }}
      </a>
    </div>
    <p v-if="state === 'loading'" class="input-hint">{{ t('admin.claudexAccountProfile.loading') }}</p>
    <p v-else-if="state === 'failed'" class="input-hint">{{ t('admin.claudexAccountProfile.failed') }}</p>
    <p v-else-if="!profile" class="input-hint">{{ t('admin.claudexAccountProfile.none') }}</p>
    <dl v-else class="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="text-gray-500 dark:text-dark-400">{{ t('admin.claudexAccountProfile.displayName') }}</dt>
      <dd class="break-words text-gray-900 dark:text-white">{{ profile.display_name }}</dd>
      <dt class="text-gray-500 dark:text-dark-400">{{ t('admin.claudexAccountProfile.birthdate') }}</dt>
      <dd class="text-gray-900 dark:text-white">{{ profile.birthdate }}</dd>
      <dt class="text-gray-500 dark:text-dark-400">{{ t('admin.claudexAccountProfile.terms') }}</dt>
      <dd class="text-gray-900 dark:text-white">{{ termsLine }}</dd>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminAPI } from '@/api/admin'
import type { AccountProfile } from '@/api/admin/claudex/accountProfile'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{ userId: number | null | undefined }>()
const { t } = useI18n()
const state = ref<'loading' | 'ready' | 'failed'>('loading')
const profile = ref<AccountProfile | null>(null)

const termsLine = computed(() => {
  const p = profile.value
  if (!p) return ''
  if (p.terms_version !== p.current_terms_version)
    return t('admin.claudexAccountProfile.termsOutdated', { version: p.terms_version, current: p.current_terms_version })
  return t('admin.claudexAccountProfile.termsAccepted', {
    version: p.terms_version,
    date: p.terms_accepted_at ? formatDateTime(p.terms_accepted_at) : ''
  })
})

let request = 0
watch(
  () => props.userId,
  async (id) => {
    const mine = ++request
    profile.value = null
    if (!id) return
    state.value = 'loading'
    try {
      const value = await adminAPI.claudex.accountProfile.getAccountProfile(id)
      if (mine !== request) return
      profile.value = value
      state.value = 'ready'
    } catch {
      if (mine === request) state.value = 'failed'
    }
  },
  { immediate: true }
)
</script>
