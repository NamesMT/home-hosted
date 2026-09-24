import { createFactory } from 'hono/factory'

/**
 * Every route is built from this factory and chained (`app.get(...).post(...)`)
 * so Hono keeps the full route map in its type — which is what `AppType` exports
 * for `hc<AppType>` clients and for the generated OpenAPI document.
 */
export const appFactory = createFactory()
