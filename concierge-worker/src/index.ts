import type { Env } from "./env"
import { serviceClient } from "./supabase"
import { setWebhook, type TelegramUpdate } from "./telegram"

export { PatientAgent } from "./patient-agent"

async function routeWebhook(request: Request, env: Env): Promise<Response> {
  // Optional Telegram secret token gate.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const provided = request.headers.get("x-telegram-bot-api-secret-token")
    if (provided !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 })
    }
  }

  let update: TelegramUpdate
  try {
    update = (await request.json()) as TelegramUpdate
  } catch {
    return new Response("bad-request", { status: 400 })
  }

  const tgUserId = update.message?.from?.id ?? update.callback_query?.from?.id
  if (!tgUserId) {
    // Channel posts, edited messages, etc. — out of scope.
    return new Response("ok", { status: 200 })
  }

  // Route to the right DO. Linked patients are addressed by their stable
  // profile UUID; pre-link conversations live under tg:<id>.
  const svc = serviceClient(env)
  const { data: rows } = await svc.rpc("concierge_lookup_patient_by_telegram", {
    p_telegram_user_id: tgUserId
  })
  const link = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  const doName = link?.patient_id ? `patient:${link.patient_id}` : `tg:${tgUserId}`

  const id = env.PATIENT_AGENT.idFromName(doName)
  const stub = env.PATIENT_AGENT.get(id)

  await stub.fetch("https://do.local/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update })
  })
  return new Response("ok", { status: 200 })
}

async function setupWebhookHandler(request: Request, env: Env): Promise<Response> {
  if (env.ADMIN_SECRET) {
    const provided = request.headers.get("x-admin-secret")
    if (provided !== env.ADMIN_SECRET) {
      return new Response("forbidden", { status: 403 })
    }
  }
  const url = new URL(request.url).searchParams.get("url")
  if (!url) return new Response("missing ?url=", { status: 400 })

  try {
    const result = await setWebhook(env, url, env.TELEGRAM_WEBHOOK_SECRET)
    return Response.json({ ok: true, result })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/healthz") return new Response("ok", { status: 200 })

    if (url.pathname === "/webhook/telegram" && request.method === "POST") {
      return routeWebhook(request, env)
    }
    if (url.pathname === "/admin/setup-webhook" && request.method === "POST") {
      return setupWebhookHandler(request, env)
    }

    return new Response("not-found", { status: 404 })
  }
} satisfies ExportedHandler<Env>
