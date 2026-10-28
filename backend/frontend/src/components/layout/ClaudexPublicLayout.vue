<!--
  CLAUDEX: LOGIN frame of the public pages end users reach (/desktop-only,
  /desktop-pay, /payment/result, /reset-password, /legal/*): the Claudex star
  and serif wordmark at the top left, a centered serif title and subtitle, and
  a rounded card, the same look as the sign-in page (tokens in
  claudexPublic.css). Provisional: these pages have no reference capture.

  Slots: default (the card, or the document body when variant="document"),
  below (secondary buttons under the card), footer (small print under those),
  actions (right side of the header).
-->
<template>
  <div class="cx-public" data-testid="claudex-public-layout">
    <header class="cx-public__header">
      <!-- The Claudex web app lives at the site root, outside this SPA: a plain link -->
      <a href="/" class="cx-public__brand" data-testid="claudex-public-brand">
        <svg
          class="cx-public__star"
          viewBox="120 120 784 784"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          stroke-width="64"
          stroke-linejoin="round"
        >
          <path v-for="d in KNOT_PATHS" :key="d" :d="d" />
        </svg>
        <span class="cx-public__wordmark">Claudex</span>
      </a>
      <slot name="actions" />
    </header>

    <main v-if="variant === 'document'" class="cx-public__doc">
      <slot />
    </main>
    <main v-else class="cx-public__main">
      <slot name="heading">
        <h1 v-if="title" class="cx-public__title">{{ title }}</h1>
        <p v-if="subtitle" class="cx-public__subtitle">{{ subtitle }}</p>
      </slot>
      <div v-if="$slots.default" class="cx-public__card" :class="{ 'cx-public__card--wide': wide }">
        <slot />
      </div>
      <div v-if="$slots.below" class="cx-public__below">
        <slot name="below" />
      </div>
      <div v-if="$slots.footer" class="cx-public__footer cx-print">
        <slot name="footer" />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import './claudexPublic.css'

withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    /** 'centered' (title, card) or 'document' (a readable text column). */
    variant?: 'centered' | 'document'
    /** A 480px card instead of 400px (payment forms). */
    wide?: boolean
  }>(),
  { title: '', subtitle: '', variant: 'centered', wide: false }
)

/** The Claudex knot (public-web/favicon.svg). */
const KNOT_PATHS = [
  'M392 492C282 362 362 182 582 162 632 262 622 402 392 492Z',
  'M469.3 398.1C526.9 237.8 722.8 217.1 850.1 397.6 788.5 490.9 662.3 552.3 469.3 398.1Z',
  'M589.3 418.1C756.9 387.8 872.8 547.1 780.1 747.6 668.5 740.9 552.3 662.3 589.3 418.1Z',
  'M632 532C742 662 662 842 442 862 392 762 402 622 632 532Z',
  'M554.7 625.9C497.1 786.2 301.2 806.9 173.9 626.4 235.5 533.1 361.7 471.7 554.7 625.9Z',
  'M434.7 605.9C267.1 636.2 151.2 476.9 243.9 276.4 355.5 283.1 471.7 361.7 434.7 605.9Z'
]
</script>
