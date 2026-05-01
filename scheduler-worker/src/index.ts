import type { Env } from "./env"
import { send24hReminders } from "./reminders"
import {
  createPostConsultDispatches,
  sendDueDispatchesAndReminders,
  markAbandoned
} from "./dispatches"

interface RunResult {
  ok: true
  ran_at: string
  reminders: { sent: number; checked: number }
  dispatches_created: number
  dispatches_pushed: number
  abandoned: number
}

async function runOnce(env: Env): Promise<RunResult> {
  // Order matters slightly:
  //   1) create new PREM/PROM dispatches first, so step 3 can pick them up
  //   2) 24h reminders (independent)
  //   3) push due dispatches (initial + 48h + 7d reminders)
  //   4) abandon stale
  const [created, reminders] = await Promise.all([
    createPostConsultDispatches(env),
    send24hReminders(env)
  ])
  const pushed = await sendDueDispatchesAndReminders(env)
  const abandoned = await markAbandoned(env)

  return {
    ok: true,
    ran_at: new Date().toISOString(),
    reminders,
    dispatches_created: created.created,
    dispatches_pushed: pushed.pushed,
    abandoned: abandoned.abandoned
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/healthz") return new Response("ok", { status: 200 })

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
    ctx.waitUntil(
      runOnce(env).then(
        (r) => console.log("scheduler runOnce", r),
        (err) => console.error("scheduler runOnce failed", err)
      )
    )
  }
} satisfies ExportedHandler<Env>
