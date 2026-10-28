<!--
  CLAUDEX: sign-up profile (owner, 2026-10-12): /legal/terms is the Claudex
  Terms of Service, built in like the admin compliance commitment
  (docs/legal/terms.*.md); the apps link it from the sign-up step and
  Settings, and /legal/terms#acceptable-use opens its Acceptable Use section.
  CLAUDEX: LOGIN the frame of /legal/:documentId is ClaudexPublicLayout (the
  sign-in page's look: star and serif wordmark, a readable text column); the
  document body keeps its Markdown styling. The wordmark goes to the Claudex
  web app at '/'.
-->
<template>
  <ClaudexPublicLayout variant="document">
    <div data-testid="legal-document">
      <div v-if="loading" class="flex min-h-[320px] items-center justify-center" role="status">
        <div class="cx-spinner"></div>
      </div>

      <section v-else-if="loadError" class="cx-stack cx-stack--tight" data-testid="legal-load-failed">
        <h1 class="legal-document-title">{{ t('legal.loadFailed') }}</h1>
        <p class="cx-text cx-text--error">{{ t('legal.retryLater') }}</p>
      </section>

      <section v-else-if="!currentDocument" class="cx-stack cx-stack--tight" data-testid="legal-not-found">
        <h1 class="legal-document-title">{{ t('legal.notFound') }}</h1>
        <p class="cx-text">{{ t('legal.notFoundDescription') }}</p>
      </section>

      <article v-else>
        <div class="legal-document-head">
          <p class="cx-print legal-document-kind">{{ documentTypeLabel }}</p>
          <!-- CLAUDEX: LOGIN serif title -->
          <h1 class="legal-document-title mt-2 break-words">
            {{ currentDocument.title }}
          </h1>
          <p v-if="updatedAt" class="cx-print legal-document-kind mt-3">
            {{ t('legal.updatedAt', { date: updatedAt }) }}
          </p>
        </div>

        <div
          v-if="hasContent"
          class="legal-document-content"
          v-html="renderedHtml"
        ></div>
        <div
          v-else
          class="cx-text py-14 text-center"
        >
          {{ t('legal.empty') }}
        </div>
      </article>
    </div>
  </ClaudexPublicLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useI18n } from 'vue-i18n'
import { getLocale } from '@/i18n'
import ClaudexPublicLayout from '@/components/layout/ClaudexPublicLayout.vue' // CLAUDEX: LOGIN
import { useAppStore } from '@/stores/app'
import type { LoginAgreementDocument } from '@/types'
import zhAdminCompliance from '../../../../docs/legal/admin-compliance.zh.md?raw'
import enAdminCompliance from '../../../../docs/legal/admin-compliance.en.md?raw'
import zhTerms from '../../../../docs/legal/terms.zh.md?raw'
import enTerms from '../../../../docs/legal/terms.en.md?raw'

const route = useRoute()
const { t } = useI18n()
const appStore = useAppStore()
const settings = computed(() => appStore.cachedPublicSettings)
const loading = ref(!settings.value)
const loadError = ref(false)

marked.setOptions({
  breaks: true,
  gfm: true,
})

const documentId = computed(() => String(route.params.documentId || ''))
const isAdminComplianceDocument = computed(() => documentId.value === 'admin-compliance')
const isTermsDocument = computed(() => documentId.value === 'terms')
const isBuiltInDocument = computed(() => isAdminComplianceDocument.value || isTermsDocument.value)
const documents = computed(() => settings.value?.login_agreement_documents ?? [])
const updatedAt = computed(() =>
  isBuiltInDocument.value ? '' : settings.value?.login_agreement_updated_at || ''
)
const documentTypeLabel = computed(() =>
  isAdminComplianceDocument.value
    ? t('legal.adminCompliance')
    : isTermsDocument.value
      ? 'Claudex'
      : t('legal.loginAgreement')
)

const currentDocument = computed<LoginAgreementDocument | null>(() => {
  if (isAdminComplianceDocument.value) {
    return {
      id: 'admin-compliance',
      title: t('adminCompliance.title'),
      content_md: getLocale() === 'zh' ? zhAdminCompliance : enAdminCompliance
    }
  }
  if (isTermsDocument.value) {
    return {
      id: 'terms',
      title: t('legal.termsOfService'),
      content_md: getLocale() === 'zh' ? zhTerms : enTerms
    }
  }
  const id = documentId.value
  if (!id) {
    return null
  }
  return documents.value.find((doc) => doc.id === id) ?? null
})

const hasContent = computed(() => Boolean(currentDocument.value?.content_md?.trim()))

const renderedHtml = computed(() => {
  const content = currentDocument.value?.content_md?.trim() || ''
  if (!content) {
    return ''
  }
  const html = marked.parse(content) as string
  return DOMPurify.sanitize(html)
})

onMounted(async () => {
  loadError.value = false
  if (isBuiltInDocument.value) {
    // Built-in documents need no settings: shown at once.
    loading.value = false
    scrollToHash()
    return
  }
  const loadedSettings = await appStore.fetchPublicSettings()
  if (!loadedSettings) {
    loadError.value = true
  }
  loading.value = false
  scrollToHash()
})

// CLAUDEX: a link to a section (#acceptable-use) lands on it once the body is drawn.
function scrollToHash() {
  const id = decodeURIComponent((route.hash || '').slice(1))
  if (!id) return
  void nextTick(() => document.getElementById(id)?.scrollIntoView())
}
</script>

<style scoped>
/* CLAUDEX: LOGIN document head and serif title, like the sign-in page */
.legal-document-head {
  margin-bottom: 32px;
  padding-bottom: 24px;
  border-bottom: 0.5px solid var(--auth-card-border);
}

.legal-document-head .legal-document-kind {
  text-align: left;
}

.legal-document-title {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 40px;
  font-weight: 400;
  line-height: 1.15;
  letter-spacing: -0.6px;
  color: var(--auth-text);
}

.legal-document-content {
  line-height: 1.75;
  overflow-wrap: anywhere;
  color: inherit;
}

.legal-document-content :deep(h1) {
  @apply mb-4 mt-8 border-b border-gray-200 pb-3 text-3xl font-bold dark:border-dark-700;
}

.legal-document-content :deep(h2) {
  @apply mb-3 mt-7 text-2xl font-bold;
}

.legal-document-content :deep(h3) {
  @apply mb-2 mt-6 text-xl font-semibold;
}

.legal-document-content :deep(h4) {
  @apply mb-2 mt-5 text-lg font-semibold;
}

.legal-document-content :deep(p) {
  @apply mb-4 text-gray-700 dark:text-dark-200;
}

.legal-document-content :deep(a) {
  @apply text-primary-600 underline underline-offset-4 hover:text-primary-700 dark:text-primary-300 dark:hover:text-primary-200;
}

.legal-document-content :deep(ul) {
  @apply mb-4 list-disc pl-6;
}

.legal-document-content :deep(ol) {
  @apply mb-4 list-decimal pl-6;
}

.legal-document-content :deep(li) {
  @apply mb-1 text-gray-700 dark:text-dark-200;
}

.legal-document-content :deep(blockquote) {
  @apply my-5 border-l-4 border-gray-300 pl-4 text-gray-600 dark:border-dark-600 dark:text-dark-300;
}

.legal-document-content :deep(code) {
  @apply rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm dark:bg-dark-800;
}

.legal-document-content :deep(pre) {
  @apply my-5 overflow-x-auto rounded-lg bg-gray-950 p-4 text-gray-100;
}

.legal-document-content :deep(pre code) {
  @apply bg-transparent p-0 text-inherit;
}

.legal-document-content :deep(table) {
  @apply my-5 block w-full overflow-x-auto border-collapse;
}

.legal-document-content :deep(th) {
  @apply border border-gray-300 bg-gray-50 px-3 py-2 text-left font-semibold dark:border-dark-600 dark:bg-dark-800;
}

.legal-document-content :deep(td) {
  @apply border border-gray-300 px-3 py-2 dark:border-dark-600;
}

.legal-document-content :deep(img) {
  @apply my-5 h-auto max-w-full rounded-lg;
}

.legal-document-content :deep(hr) {
  @apply my-7 border-gray-200 dark:border-dark-700;
}
</style>
