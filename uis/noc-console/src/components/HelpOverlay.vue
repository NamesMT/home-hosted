<script setup lang="ts">
import { useUi } from '@/composables/useUi'

const { helpOpen } = useUi()

interface Row {
  combo: string
  label: string
}

const groups: Array<{ title: string, rows: Row[] }> = [
  {
    title: 'navigate',
    rows: [
      { combo: 'g s', label: 'servers' },
      { combo: 'g l', label: 'logs' },
      { combo: 'g v', label: 'host vitals' },
      { combo: 'g t', label: 'settings' },
      { combo: 'j / k', label: 'move selection' },
      { combo: 'Home / G', label: 'first / last' },
      { combo: '/', label: 'filter the list' },
    ],
  },
  {
    title: 'act on the selected server',
    rows: [
      { combo: 's', label: 'start' },
      { combo: 'x', label: 'stop' },
      { combo: 'r', label: 'restart' },
      { combo: 'e', label: 'edit config' },
      { combo: 'l', label: 'live log drawer' },
      { combo: 'c', label: 'clear logs' },
      { combo: 'a', label: 'add a server' },
    ],
  },
  {
    title: 'console',
    rows: [
      { combo: '?', label: 'this help' },
      { combo: 'esc', label: 'close overlay / drawer' },
      { combo: 'enter', label: 'open the selected row' },
    ],
  },
]
</script>

<template>
  <div v-if="helpOpen" class="overlay" @click.self="helpOpen = false">
    <div class="overlay__panel" role="dialog" aria-label="keyboard shortcuts">
      <div class="overlay__head">
        <span class="overlay__title">keyboard</span>
        <span class="view__spacer" />
        <kbd class="kbd">esc</kbd>
        <button type="button" class="btn btn--xs btn--ghost" @click="helpOpen = false">
          close
        </button>
      </div>
      <div class="overlay__body">
        <div class="keys">
          <template v-for="group in groups" :key="group.title">
            <div class="keys__group">
              {{ group.title }}
            </div>
            <div v-for="row in group.rows" :key="row.combo" class="keys__row">
              <span class="keys__combo">
                <kbd v-for="part in row.combo.split(' ')" :key="part" class="kbd">{{ part }}</kbd>
              </span>
              <span class="keys__label">{{ row.label }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
