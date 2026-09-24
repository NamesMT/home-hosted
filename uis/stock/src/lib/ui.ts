/** Shared control styling, so every form on every page agrees. */

export const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-page'

export const labelClass = 'text-xs font-medium text-muted'

export const hintClass = 'text-2xs leading-4 text-faint'

export const inputClass = [
  'w-full min-w-0 rounded-control border border-line bg-page/60 px-2.5 py-1.5 text-sm text-ink',
  'placeholder:text-faint transition-colors duration-150',
  'hover:border-line/80 hover:bg-page',
  'focus:border-accent focus:bg-page focus:outline-none focus:ring-2 focus:ring-accent/25',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25',
].join(' ')

export const monoInputClass = `${inputClass} font-mono text-xs`
