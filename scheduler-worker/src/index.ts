import type { Env } from "./env"

/**
 * One pass of the scheduler. Phase 5 fills this in:
 *   1) 24h appointment reminders
 *   2) Post-consult dispatches (PREM @ T+24h, PROM @ T+7d, T+28d)
 *   3) Reminder cascade (+48h, +7d, then abandon)
 *
 * Phase 0: stub that just reports "ran".
 */
async function runOnce(_env: Env): Promise<{ ok: true; ran_at: string }> {
  return { ok: true, ran_at: new Date().toISOString() }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 })
    }

    if (url.pathname === "/admin/cron/run" && request.method === "POST") {
      const provided = request.headers.get("x-admin-secret")
      if (!provided || provided !== env.ADMIN_SECRET) {
        return new Response("forbidden", { status: 403 })
      }
      const result = await runOnce(env)
      return Response.json(result)
    }

    return new Response("not-found", { status: 404 })
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOnce(env).then(() => undefined))
  }
} satisfies ExportedHandler<Env>
