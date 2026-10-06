import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { WorkspaceError } from '#src/config/workspaces'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { workspaceCreateSchema, workspaceRenameSchema, workspaceViewSchema } from '#src/shared/contracts'

const idParam = type({ id: 'string >= 1' })
const workspacesResponse = type({ workspaces: workspaceViewSchema.array() })
const workspaceResponse = type({ workspace: workspaceViewSchema })
const removedResponse = type({ ok: 'boolean', removed: type({ id: 'string', label: 'string' }) })

/** A registry failure is an API failure: unknown ids are 404, conflicts 409, the rest 400. */
function workspaceFailure(error: unknown): never {
  if (error instanceof WorkspaceError) {
    // The exception carries the kind. Matching the message would misroute a *validation* failure
    // whose summary happened to begin `unknown workspace` or end `already exists`.
    const unknown = error.code === 'UNKNOWN_WORKSPACE'
    const conflict = error.code === 'WORKSPACE_EXISTS'
    throw new DetailedError(error.message, {
      statusCode: unknown ? 404 : conflict ? 409 : 400,
      code: unknown ? 'UNKNOWN_WORKSPACE' : conflict ? 'WORKSPACE_EXISTS' : 'INVALID_WORKSPACE',
    })
  }
  throw error
}

/** A workspace selector needs the list, and the CRUD behind it. */
export function createWorkspacesRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/',
      describeRoute({
        tags: ['workspaces'],
        summary: 'Every workspace, with its live state',
        responses: { 200: { description: 'The workspaces', content: jsonBody(workspacesResponse) } },
      }),
      c => c.json({ workspaces: deps.panel.workspaces().map(workspace => workspace.view()) }),
    )

    .post(
      '/',
      describeRoute({
        tags: ['workspaces'],
        summary: 'Create a workspace',
        responses: {
          201: { description: 'Created', content: jsonBody(workspaceResponse) },
          400: ERROR_RESPONSES[400],
        },
      }),
      validate('json', workspaceCreateSchema),
      (c) => {
        try {
          return c.json({ workspace: deps.panel.create(c.req.valid('json')) }, 201)
        }
        catch (error) {
          workspaceFailure(error)
        }
      },
    )

    .patch(
      '/:id',
      describeRoute({
        tags: ['workspaces'],
        summary: 'Rename a workspace',
        responses: {
          200: { description: 'Renamed', content: jsonBody(workspaceResponse) },
          400: ERROR_RESPONSES[400],
          404: ERROR_RESPONSES[404],
        },
      }),
      validate('param', idParam),
      validate('json', workspaceRenameSchema),
      (c) => {
        try {
          return c.json({ workspace: deps.panel.rename(c.req.valid('param').id, c.req.valid('json').label) })
        }
        catch (error) {
          workspaceFailure(error)
        }
      },
    )

    .delete(
      '/:id',
      describeRoute({
        tags: ['workspaces'],
        summary: 'Stop and remove a workspace',
        responses: {
          200: { description: 'Removed', content: jsonBody(removedResponse) },
          400: ERROR_RESPONSES[400],
          404: ERROR_RESPONSES[404],
        },
      }),
      validate('param', idParam),
      async (c) => {
        try {
          const removed = await deps.panel.remove(c.req.valid('param').id)
          return c.json({ ok: true, removed: { id: removed.id, label: removed.label } })
        }
        catch (error) {
          workspaceFailure(error)
        }
      },
    )
}
