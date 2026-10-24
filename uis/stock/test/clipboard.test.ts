// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import CopyButton from '../src/components/ui/CopyButton.vue'
import { useToasts } from '../src/composables/useToasts'
import { t } from '../src/i18n'
import { copyText } from '../src/lib/clipboard'

/**
 * A copy button that silently does nothing is the defect this file guards.
 *
 * `navigator.clipboard` exists only in a **secure context**. The panel is documented to be
 * opened from a phone over plain `http://` on a LAN (`docs/UI_CREATION.md` point 7), and there
 * `navigator.clipboard` is `undefined` — measured on the built panel: the same page on
 * `http://192.168.1.201:6181` reported `typeof navigator.clipboard === 'undefined'` and
 * `isSecureContext === false`, while `http://127.0.0.1:6181` had both. So every one of the
 * nine `CopyButton` call sites (the archive directory, the logs directory, the TLS
 * fingerprint, a server's JSON config, the proxy's `setcap` line…) threw a `TypeError` into a
 * `catch {}` that only left the icon alone: the person pressed Copy, the clipboard kept its
 * old contents, and nothing said so.
 *
 * The fix is `copyText` (`src/lib/clipboard.ts`): the modern API where it exists, the legacy
 * `execCommand('copy')` path where it does not (that one works inside a user gesture on an
 * insecure origin), and an honest `false` when neither works — which the button turns into a
 * warning icon and a toast.
 */

const writeText = vi.fn<(text: string) => Promise<void>>()
const execCommand = vi.fn<(command: string) => boolean>()

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  execCommand.mockReset()
  execCommand.mockReturnValue(true)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
})

afterEach(() => {
  // Leave no textarea behind: the legacy path must clean up even when it fails.
  expect(document.querySelectorAll('textarea')).toHaveLength(0)
})

describe('copyText', () => {
  it('uses the Clipboard API when the origin is secure', async () => {
    await expect(copyText('secret')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('secret')
    // The legacy path is the fallback, not a second write on every click.
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the Clipboard API is absent (a plain-http LAN origin)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await expect(copyText('/srv/logs')).resolves.toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back when the Clipboard API exists but refuses', async () => {
    // An insecure context can still expose the object and reject every write.
    writeText.mockRejectedValue(new TypeError('not allowed'))
    await expect(copyText('x')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('says so when neither path can write', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execCommand.mockReturnValue(false)
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('says so when execCommand throws, and still removes its textarea', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execCommand.mockImplementation(() => {
      throw new Error('denied')
    })
    await expect(copyText('x')).resolves.toBe(false)
  })
})

describe('copy button', () => {
  it('flashes "Copied" and writes the value on a secure origin', async () => {
    const wrapper = mount(CopyButton, { props: { value: 'panel-version-0.10.0', label: 'Copy the version' } })
    expect(wrapper.get('button').attributes('aria-label')).toBe('Copy the version')

    await wrapper.get('button').trigger('click')
    await flush()
    expect(writeText).toHaveBeenCalledWith('panel-version-0.10.0')
    expect(wrapper.get('button').attributes('aria-label')).toBe(t('common.copied'))

    // And it returns to the resting state, so the next click still reads as an action.
    await new Promise(resolve => setTimeout(resolve, 1500))
    await flush()
    expect(wrapper.get('button').attributes('aria-label')).toBe('Copy the version')
    wrapper.unmount()
  })

  it('still copies on a plain-http origin, where navigator.clipboard does not exist', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const wrapper = mount(CopyButton, { props: { value: '/home/you/.home-hosted/.hh/.logs', label: 'Copy the logs directory' } })

    await wrapper.get('button').trigger('click')
    await flush()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(wrapper.get('button').attributes('aria-label')).toBe(t('common.copied'))
    wrapper.unmount()
  })

  it('shows a warning and a toast when the copy did not happen', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execCommand.mockReturnValue(false)
    const toasts = useToasts()
    const before = toasts.toasts.value.length

    const wrapper = mount(CopyButton, { props: { value: 'x', label: 'Copy the fingerprint' } })
    await wrapper.get('button').trigger('click')
    await flush()

    // The aria-label is what a screen reader hears; the icon alone would be silent.
    expect(wrapper.get('button').attributes('aria-label')).toBe(t('common.copyFailed'))
    expect(wrapper.get('button').attributes('aria-label')).not.toBe(t('common.copied'))
    expect(toasts.toasts.value.length).toBe(before + 1)
    expect(toasts.toasts.value.at(-1)?.title).toBe(t('common.copyFailed'))
    wrapper.unmount()
  })
})

/** Two ticks: the click handler awaits `copyText`, which awaits before setting state. */
async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await Promise.resolve()
}
