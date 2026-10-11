<script setup lang="ts">
/**
 * One field group's frame on a settings page: the anchor the rail scrolls to and
 * the heading above it. Both settings pages repeated this seven (resp. four) times.
 */
defineProps<{
  /** Must match the rail entry and the `route.query.section` value. */
  id: string
  title: string
  description: string
}>()
</script>

<template>
  <section :id="id" class="scroll-mt-5">
    <header class="mb-3">
      <h2 class="text-lg font-semibold text-ink">
        {{ title }}
      </h2>
      <p class="mt-0.5 text-xs text-muted">
        {{ description }}
      </p>
    </header>
    <slot />
  </section>
</template>
