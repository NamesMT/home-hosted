import type { Entry, SupervisorContext } from '#src/services/supervisor/entry'
import { isComposeCommand, stopComposeContainers } from '#src/providers/docker'
import { detectCompose, resolveSpawn } from '#src/services/supervisor/spawn'

/**
 * Stops the running containers of a compose entry. Its server is the containers, which are not the
 * wrapper's descendants: a reboot, a `compose up -d` from a shell or a panel crash leaves them up with
 * no child to signal, and "stopped" would be a lie.
 *
 * `null` means "no compose stack, or docker could not be asked" — the caller then reports only what
 * it can see, never a stack it did not confirm is gone.
 */
export async function stopComposeStack(ctx: SupervisorContext, entry: Entry): Promise<{ stopped: string[], survivors: string[] } | null> {
  // An entry this panel never started has no detected target yet; resolve it rather than skip the stack.
  if (entry.compose === null && !isComposeCommand(entry.config.command, entry.config.args))
    return null
  if (entry.compose === null)
    detectCompose(entry, resolveSpawn(ctx, entry))
  if (entry.compose === null)
    return null
  const outcome = await stopComposeContainers(entry.compose)
  if (outcome === null) {
    ctx.log(entry, 'system', 'docker could not be asked to stop this stack — its containers were not confirmed stopped')
    return null
  }
  if (outcome.stopped.length > 0)
    ctx.log(entry, 'system', `stopped the container${outcome.stopped.length === 1 ? '' : 's'} ${outcome.stopped.join(', ')}`)
  return outcome
}

/** Marks a stop that did not take because a container outlived it, and reports whether it happened. */
export function refuseLingeringStack(ctx: SupervisorContext, entry: Entry, stack: { survivors: string[] } | null): boolean {
  const survivors = stack?.survivors ?? []
  if (survivors.length === 0)
    return false
  entry.status = 'conflict'
  entry.lastError = `the stack "${entry.config.id}" is still running: container${survivors.length === 1 ? '' : 's'} ${survivors.join(', ')} — docker was asked to stop them and they stayed up`
  // Logged too: a pid that also survived replaces `lastError`, and the stack must stay on record.
  ctx.log(entry, 'system', entry.lastError)
  return true
}
