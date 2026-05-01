import type { Env } from "./env"
import { serviceClient } from "./supabase"
import { setWebhook, type TelegramUpdate } from "./telegram"
import { seedFaqCorpus } from "./faq"
import { nanoid10 } from "./short-id"

export { PatientAgent } from "./patient-agent"

interface DispatchPayload {
  type: "form_dispatch" | "reminder"
  patient_id: string
  dispatch_id?: string
  text?: string
}

/**
 * Look up the patient's Telegram chat id and forward a dispatch payload
 * to the right PatientAgent DO.
 */
async function forwardDispatchToDO(env: Env, p: DispatchPayload): Promise<boolean> {
  const svc = serviceClient(env)
  const { data: link } = await svc
    .from("concierge_telegram_links")
    .select("telegram_user_id")
    .eq("patient_id", p.patient_id)
    .maybeSingle()
  if (!link) return false

  // Same routing convention as the webhook path — DO is keyed on tg:<id>.
  const id = env.PATIENT_AGENT.idFromName(`tg:${link.telegram_user_id}`)
  const stub = env.PATIENT_AGENT.get(id)
  await stub.fetch("https://do.local/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dispatch: {
        type: p.type,
        chat_id: link.telegram_user_id,
        dispatch_id: p.dispatch_id,
        text: p.text
      }
    })
  })
  return true
}

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

  // Always route by Telegram user ID. The link table still serves the
  // scheduler's reverse lookup (patient_id → telegram_user_id), but the
  // DO instance is keyed on the Telegram ID for the entire conversation
  // lifecycle. Routing on patient:<uuid> after the link was created
  // would lose state stored under tg:<id> during the OTP flow.
  const doName = `tg:${tgUserId}`
  const id = env.PATIENT_AGENT.idFromName(doName)
  const stub = env.PATIENT_AGENT.get(id)

  await stub.fetch("https://do.local/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update })
  })
  return new Response("ok", { status: 200 })
}

/**
 * Manually create a form dispatch and push it to the patient. Used for
 * the demo before the scheduler-worker takes over.
 *
 * curl -X POST $WORKER/admin/test-dispatch \
 *   -H "x-admin-secret: ..." \
 *   -d '{"appointment_id":"<uuid>","template_id":"PREM_v1","schedule_label":"PREM_T24h"}'
 */
async function testDispatchHandler(request: Request, env: Env): Promise<Response> {
  if (env.ADMIN_SECRET) {
    const provided = request.headers.get("x-admin-secret")
    if (provided !== env.ADMIN_SECRET) {
      return new Response("forbidden", { status: 403 })
    }
  }
  let body: { appointment_id?: string; template_id?: string; schedule_label?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return new Response("bad-request", { status: 400 })
  }
  if (!body.appointment_id || !body.template_id || !body.schedule_label) {
    return Response.json({ ok: false, error: "missing fields" }, { status: 400 })
  }

  const svc = serviceClient(env)
  const dispatch_id = nanoid10()
  const { error: dispErr } = await svc.rpc("dispatch_concierge_form", {
    p_id: dispatch_id,
    p_appointment_id: body.appointment_id,
    p_template_id: body.template_id,
    p_schedule_label: body.schedule_label,
    p_scheduled_for: new Date().toISOString()
  })
  if (dispErr) {
    return Response.json({ ok: false, error: dispErr.message }, { status: 500 })
  }

  // Read back the (possibly pre-existing) dispatch to get the canonical id
  // and patient_id (RPC is idempotent on (appointment_id, schedule_label)).
  const { data: row } = await svc
    .from("concierge_form_dispatches")
    .select("id, patient_id")
    .eq("appointment_id", body.appointment_id)
    .eq("schedule_label", body.schedule_label)
    .maybeSingle()
  if (!row) {
    return Response.json({ ok: false, error: "dispatch row missing post-rpc" }, { status: 500 })
  }

  const ok = await forwardDispatchToDO(env, {
    type: "form_dispatch",
    patient_id: row.patient_id,
    dispatch_id: row.id
  })
  return Response.json({ ok, dispatch_id: row.id })
}

async function seedFaqHandler(request: Request, env: Env): Promise<Response> {
  if (env.ADMIN_SECRET) {
    const provided = request.headers.get("x-admin-secret")
    if (provided !== env.ADMIN_SECRET) {
      return new Response("forbidden", { status: 403 })
    }
  }
  const result = await seedFaqCorpus(env)
  return Response.json({ ok: true, ...result })
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
    if (url.pathname === "/admin/seed-faq" && request.method === "POST") {
      return seedFaqHandler(request, env)
    }
    if (url.pathname === "/admin/test-dispatch" && request.method === "POST") {
      return testDispatchHandler(request, env)
    }
    if (url.pathname === "/internal/dispatch" && request.method === "POST") {
      // Service-binding-only. Trust the caller (only scheduler-worker
      // can hit this in production).
      let body: DispatchPayload
      try {
        body = (await request.json()) as DispatchPayload
      } catch {
        return new Response("bad-request", { status: 400 })
      }
      const ok = await forwardDispatchToDO(env, body)
      return Response.json({ ok })
    }

    return new Response("not-found", { status: 404 })
  }
} satisfies ExportedHandler<Env>
