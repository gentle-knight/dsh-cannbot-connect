/**
 * The one read-only HTTP route the Settings page uses for Host facts it cannot
 * derive from the settings document (credentials and the live catalog).
 *
 * There is deliberately no write route: settings writes travel through the
 * platform's revisioned `configForms`/`settings` API, so this surface cannot be
 * tricked into a cross-site mutation.
 *
 * @module dsh-cannbot-connect/web
 */

/** Exact path the browser half reads. */
export const STATUS_PATH = '/cannbot-connect/status'

/** JSON response with the no-store policy the status route always needs. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Register the status resource on an already-resolved WebServer.
 * @param ctx - context carrying `webServer`.
 * @param readStatus - synchronous producer of the safe status document.
 * @returns the route disposer, or a no-op when no WebServer is mounted.
 */
export function registerStatusRoute(ctx, readStatus) {
  if (typeof ctx?.webServer?.register !== 'function') return () => {}
  return ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    auth: 'required',
    resource: async () => {
      try {
        return json(200, readStatus())
      } catch {
        // A status read must never leak an internal error or fail the page.
        return json(500, { error: 'status unavailable' })
      }
    },
  })
}
