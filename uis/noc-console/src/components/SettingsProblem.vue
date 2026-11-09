<script setup lang="ts">
/** A panel-wide settings.json that could not be applied: the running settings are kept. */
defineProps<{ problem: { message: string, path: string } | null }>()
</script>

<template>
  <p v-if="problem" class="banner banner--warn">
    <strong>settings problem</strong>
    <span>{{ problem.message }}</span>
    <code>{{ problem.path }}</code>
    <span class="faint">running the last good settings; fixing the file reloads them</span>
  </p>
</template>
