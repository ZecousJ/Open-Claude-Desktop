<!--
  CLAUDEX: LOGIN /reset-password (the landing page of the reset email) uses
  ClaudexPublicLayout, the sign-in page's look. End users sign in to the
  Claudex web app at '/', so "Sign in" goes there; administrators keep a link
  to the console sign-in.
-->
<template>
  <ClaudexPublicLayout :title="t('auth.resetPasswordTitle')" :subtitle="t('auth.resetPasswordHint')">
    <!-- Invalid Link State -->
    <div v-if="isInvalidLink" class="cx-stack" data-testid="reset-password-invalid">
      <div class="cx-stack cx-stack--tight">
        <p class="cx-text"><strong>{{ t('auth.invalidResetLink') }}</strong></p>
        <p class="cx-text">{{ t('auth.invalidResetLinkHint') }}</p>
      </div>
      <!-- CLAUDEX: W-CONSOLE console path under /admin -->
      <router-link to="/admin/forgot-password" class="cx-btn cx-btn--primary">
        {{ t('auth.requestNewResetLink') }}
      </router-link>
    </div>

    <!-- Success State -->
    <div v-else-if="isSuccess" class="cx-stack" data-testid="reset-password-success">
      <div class="cx-stack cx-stack--tight">
        <p class="cx-text"><strong>{{ t('auth.passwordResetSuccess') }}</strong></p>
        <p class="cx-text">{{ t('auth.passwordResetSuccessHint') }}</p>
      </div>
      <!-- CLAUDEX: LOGIN end users sign in to the web app at '/' (outside this SPA, so a plain link) -->
      <a href="/" class="cx-btn cx-btn--primary" data-testid="reset-password-sign-in">
        {{ t('auth.signIn') }}
      </a>
    </div>

    <!-- Form State -->
    <form v-else class="cx-stack" data-testid="reset-password-form" @submit.prevent="handleSubmit">
      <!-- Email (readonly) -->
      <div class="cx-field">
        <label for="email" class="cx-label">
          {{ t('auth.emailLabel') }}
        </label>
        <input id="email" :value="email" type="email" readonly disabled class="cx-input" />
      </div>

      <!-- New Password Input -->
      <div class="cx-field">
        <label for="password" class="cx-label">
          {{ t('auth.newPassword') }}
        </label>
        <div class="cx-input-wrap">
          <input
            id="password"
            v-model="formData.password"
            :type="showPassword ? 'text' : 'password'"
            required
            autocomplete="new-password"
            :disabled="isLoading"
            class="cx-input cx-input--with-action"
            :class="{ 'cx-input--error': errors.password }"
            :placeholder="t('auth.newPasswordPlaceholder')"
          />
          <button type="button" class="cx-input-action" @click="showPassword = !showPassword">
            <Icon v-if="showPassword" name="eyeOff" size="sm" />
            <Icon v-else name="eye" size="sm" />
          </button>
        </div>
      </div>

      <!-- Confirm Password Input -->
      <div class="cx-field">
        <label for="confirmPassword" class="cx-label">
          {{ t('auth.confirmPassword') }}
        </label>
        <div class="cx-input-wrap">
          <input
            id="confirmPassword"
            v-model="formData.confirmPassword"
            :type="showConfirmPassword ? 'text' : 'password'"
            required
            autocomplete="new-password"
            :disabled="isLoading"
            class="cx-input cx-input--with-action"
            :class="{ 'cx-input--error': errors.confirmPassword }"
            :placeholder="t('auth.confirmPasswordPlaceholder')"
          />
          <button type="button" class="cx-input-action" @click="showConfirmPassword = !showConfirmPassword">
            <Icon v-if="showConfirmPassword" name="eyeOff" size="sm" />
            <Icon v-else name="eye" size="sm" />
          </button>
        </div>
      </div>

      <p v-if="errorMessage" role="alert" class="cx-text cx-text--error" data-testid="reset-password-error">
        {{ errorMessage }}
      </p>

      <!-- Submit Button -->
      <button type="submit" :disabled="isLoading" class="cx-btn cx-btn--primary" data-testid="reset-password-submit">
        <span v-if="isLoading" class="cx-spinner cx-spinner--small" aria-hidden="true"></span>
        {{ isLoading ? t('auth.resettingPassword') : t('auth.resetPassword') }}
      </button>
    </form>

    <!-- Footer -->
    <template #footer>
      <p v-if="!isSuccess">
        {{ t('auth.rememberedPassword') }}
        <!-- CLAUDEX: LOGIN the web app at '/' -->
        <a href="/" class="cx-link" data-testid="reset-password-footer-sign-in">{{ t('auth.signIn') }}</a>
      </p>
      <!-- CLAUDEX: W-CONSOLE console path under /admin, for administrators -->
      <router-link v-else to="/admin/login" class="cx-link" data-testid="reset-password-console-sign-in">
        {{ t('claudexPublic.consoleSignIn') }}
      </router-link>
    </template>
  </ClaudexPublicLayout>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ClaudexPublicLayout from '@/components/layout/ClaudexPublicLayout.vue' // CLAUDEX: LOGIN
import Icon from '@/components/icons/Icon.vue'
import { useAppStore } from '@/stores'
import { resetPassword } from '@/api/auth'

const { t } = useI18n()

// ==================== Router & Stores ====================

const route = useRoute()
const appStore = useAppStore()

// ==================== State ====================

const isLoading = ref<boolean>(false)
const isSuccess = ref<boolean>(false)
const errorMessage = ref<string>('')
const showPassword = ref<boolean>(false)
const showConfirmPassword = ref<boolean>(false)

// URL parameters
const email = ref<string>('')
const token = ref<string>('')

const formData = reactive({
  password: '',
  confirmPassword: ''
})

const errors = reactive({
  password: '',
  confirmPassword: ''
})

const validationToastMessage = computed(
  () => errors.password || errors.confirmPassword || ''
)

watch(validationToastMessage, (value, previousValue) => {
  if (value && value !== previousValue) {
    appStore.showError(value)
  }
})

// Check if the reset link is valid (has email and token)
const isInvalidLink = computed(() => !email.value || !token.value)

// ==================== Lifecycle ====================

onMounted(() => {
  // Get email and token from URL query parameters
  email.value = (route.query.email as string) || ''
  token.value = (route.query.token as string) || ''

  if (!email.value || !token.value) {
    appStore.showError(t('auth.invalidResetLink'))
  }
})

// ==================== Validation ====================

function validateForm(): boolean {
  errors.password = ''
  errors.confirmPassword = ''

  let isValid = true

  // Password validation
  if (!formData.password) {
    errors.password = t('auth.passwordRequired')
    isValid = false
  } else if (formData.password.length < 6) {
    errors.password = t('auth.passwordMinLength')
    isValid = false
  }

  // Confirm password validation
  if (!formData.confirmPassword) {
    errors.confirmPassword = t('auth.confirmPasswordRequired')
    isValid = false
  } else if (formData.password !== formData.confirmPassword) {
    errors.confirmPassword = t('auth.passwordsDoNotMatch')
    isValid = false
  }

  return isValid
}

// ==================== Form Handlers ====================

async function handleSubmit(): Promise<void> {
  errorMessage.value = ''

  if (!validateForm()) {
    return
  }

  isLoading.value = true

  try {
    await resetPassword({
      email: email.value,
      token: token.value,
      new_password: formData.password
    })

    isSuccess.value = true
    appStore.showSuccess(t('auth.passwordResetSuccess'))
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { data?: { detail?: string; code?: string } } }

    // Check for invalid/expired token error
    if (err.response?.data?.code === 'INVALID_RESET_TOKEN') {
      errorMessage.value = t('auth.invalidOrExpiredToken')
    } else if (err.response?.data?.detail) {
      errorMessage.value = err.response.data.detail
    } else if (err.message) {
      errorMessage.value = err.message
    } else {
      errorMessage.value = t('auth.resetPasswordFailed')
    }

    appStore.showError(errorMessage.value)
  } finally {
    isLoading.value = false
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: all 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
