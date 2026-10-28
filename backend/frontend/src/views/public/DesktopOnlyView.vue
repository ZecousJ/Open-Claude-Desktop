<!--
  CLAUDEX: /desktop-only. While the web console is for administrators only
  (web_console_admin_only), non-admins land here: it points them to the Claudex
  desktop app, offers its download when the server publishes one for this
  computer, and signs a still signed-in web session out.
  CLAUDEX: W-CONSOLE it also points to the Claudex web app at '/'.
  CLAUDEX: LOGIN restyled on ClaudexPublicLayout (the sign-in page's look).
-->
<template>
  <!-- CLAUDEX: LOGIN the sign-in page's look (ClaudexPublicLayout) instead of AuthLayout -->
  <ClaudexPublicLayout :title="t('desktopOnly.title')" :subtitle="t('desktopOnly.body')">
    <div class="cx-stack" data-testid="desktop-only">
      <p v-if="signedOutNonAdmin" role="status" class="cx-text" data-testid="desktop-only-not-admin">
        {{ t('desktopOnly.notAdmin') }}
      </p>

      <!-- CLAUDEX: W-CONSOLE the web app at '/' is outside the console SPA, so a plain link -->
      <a href="/" class="cx-btn cx-btn--primary" data-testid="desktop-only-web-app">
        {{ t('desktopOnly.openWebApp') }}
      </a>

      <template v-if="downloadUrl">
        <a
          :href="downloadUrl"
          class="cx-btn cx-btn--secondary"
          rel="noopener noreferrer"
          data-testid="desktop-only-download"
        >
          <Icon name="download" size="sm" />
          {{ downloadLabel }}
        </a>
        <p v-if="latestVersion" class="cx-print">
          {{ t('desktopOnly.version', { version: latestVersion }) }}
        </p>
      </template>
    </div>

    <template #footer>
      <button
        v-if="authStore.isAuthenticated"
        type="button"
        class="cx-link"
        :disabled="signingOut"
        data-testid="desktop-only-sign-out"
        @click="signOut"
      >
        {{ signingOut ? t('desktopOnly.signingOut') : t('desktopOnly.signOut') }}
      </button>
      <!-- CLAUDEX: W-CONSOLE console path under /admin -->
      <router-link v-else to="/admin/login" class="cx-link" data-testid="desktop-only-sign-in">
        {{ t('desktopOnly.backToSignIn') }}
      </router-link>
    </template>
  </ClaudexPublicLayout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ClaudexPublicLayout from '@/components/layout/ClaudexPublicLayout.vue' // CLAUDEX: LOGIN
import Icon from '@/components/icons/Icon.vue'
import { useAuthStore } from '@/stores'
import { getClientRelease } from '@/api/claudexPublic'
import { detectDesktopPlatform, type DesktopPlatformName } from '@/utils/claudexDesktopPlatform'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const downloadUrl = ref<string | null>(null)
const latestVersion = ref('')
const platform = ref<DesktopPlatformName | null>(null)
const signingOut = ref(false)

const signedOutNonAdmin = computed(() => route.query.reason === 'not_admin' && !authStore.isAuthenticated)

const PLATFORM_LABEL_KEYS: Record<DesktopPlatformName, string> = {
  darwin: 'desktopOnly.platforms.darwin',
  win32: 'desktopOnly.platforms.win32',
  linux: 'desktopOnly.platforms.linux'
}

const downloadLabel = computed(() =>
  platform.value
    ? t('desktopOnly.downloadFor', { platform: t(PLATFORM_LABEL_KEYS[platform.value]) })
    : t('desktopOnly.download')
)

async function loadDownload(): Promise<void> {
  const detected = await detectDesktopPlatform()
  if (!detected.platform) return
  try {
    const release = await getClientRelease({ platform: detected.platform, arch: detected.arch })
    const url = typeof release?.download_url === 'string' ? release.download_url.trim() : ''
    // Only an https link from the server becomes a button.
    if (!url.toLowerCase().startsWith('https://')) return
    downloadUrl.value = url
    platform.value = detected.platform
    latestVersion.value = typeof release.latest_version === 'string' ? release.latest_version : ''
  } catch {
    // No release information: the page works without the download button.
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true
  try {
    await authStore.logout()
    await router.replace('/admin/login') // CLAUDEX: W-CONSOLE console path under /admin
  } finally {
    signingOut.value = false
  }
}

onMounted(loadDownload)
</script>
