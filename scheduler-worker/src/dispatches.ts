import type { Env } from "./env"
import { serviceClient } from "./supabase"
import { pushToConcierge } from "./forwarder"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

interface DispatchSchedule {
  /** Hours after `scheduled_at + duration_min` at which to dispatch */
  after_end_ms: number
  /** Field on concierge_appointment_state to upsert post-dispatch */
  state_field:
    | "prem_dispatched_at"
    | "prom_t7_dispatched_at"
    | "prom_t28_dispatched_at"
  template_id: "PREM_v1" | "EQ5D5L_v1"
  schedule_label: "PREM_T24h" | "PROM_T7d" | "PROM_T28d"
}

const SCHEDULES: DispatchSchedule[] = [
  { after_end_ms: 24 * HOUR_MS, state_field: "prem_dispatched_at", template_id: "PREM_v1", schedule_label: "PREM_T24h" },
  { after_end_ms: 7 * DAY_MS, state_field: "prom_t7_dispatched_at", template_id: "EQ5D5L_v1", schedule_label: "PROM_T7d" },
  { after_end_ms: 28 * DAY_MS, state_field: "prom_t28_dispatched_at", template_id: "EQ5D5L_v1", schedule_label: "PROM_T28d" }
]

const MAX_LOOKBACK_DAYS = 60  // don't crawl the entire history

/**
 * For each completed appointment, create the form dispatches whose
 * "after end" time has passed and whose corresponding state field is
 * still null. Idempotent on (appointment_id, schedule_label) via the
 * dispatch_concierge_form RPC.
 */
export async function createPostConsultDispatches(env: Env): Promise<{ created: number }> {
  const sb = serviceClient(env)
  const horizon = new Date(Date.now() - MAX_LOOKBACK_DAYS * DAY_MS).toISOString()
  const now = Date.now()

  const { data: appts } = await sb
    .from("appointments")
    .select("id, scheduled_at, duration_min, patient_id")
    .eq("status", "completed")
    .gte("scheduled_at", horizon)

  if (!appts || appts.length === 0) return { created: 0 }

  const apptIds = appts.map((a) => a.id)
  const { data: states } = await sb
    .from("concierge_appointment_state")
    .select("appointment_id, prem_dispatched_at, prom_t7_dispatched_at, prom_t28_dispatched_at")
    .in("appointment_id", apptIds)
  const stateByAppt = new Map(
    (states ?? []).map((s) => [s.appointment_id, s] as const)
  )

  let created = 0
  for (const a of appts) {
    const endMs = new Date(a.scheduled_at).getTime() + a.duration_min * 60 * 1000
    for (const sched of SCHEDULES) {
      if (now < endMs + sched.after_end_ms) continue
      const st = stateByAppt.get(a.id)
      if (st && st[sched.state_field]) continue

      const dispatchId = randomShortId()
      const { error } = await sb.rpc("dispatch_concierge_form", {
        p_id: dispatchId,
        p_appointment_id: a.id,
        p_template_id: sched.template_id,
        p_schedule_label: sched.schedule_label,
        p_scheduled_for: new Date().toISOString()
      })
      if (error) {
        console.error("dispatch_concierge_form error", error.message)
        continue
      }
      await sb.rpc("concierge_set_appointment_state", {
        p_appointment_id: a.id,
        p_field: sched.state_field,
        p_value: new Date().toISOString()
      })
      created += 1
    }
  }
  return { created }
}

/**
 * Send any dispatch that's due — either initial (sent_at IS NULL and
 * scheduled_for ≤ now), or 48h-reminder (sent_at + 48h ≤ now,
 * reminder_count = 0), or 7d-reminder (sent_at + 7d ≤ now,
 * reminder_count = 1). Updates sent_at / reminder_count post-push.
 */
export async function sendDueDispatchesAndReminders(env: Env): Promise<{ pushed: number }> {
  const sb = serviceClient(env)
  const nowIso = new Date().toISOString()
  const cutoff48Iso = new Date(Date.now() - 48 * HOUR_MS).toISOString()
  const cutoff7dIso = new Date(Date.now() - 7 * DAY_MS).toISOString()

  // Three separate queries — easier to type than a single OR'd query.
  const [initial, fortyEight, sevenDay] = await Promise.all([
    sb.from("concierge_form_dispatches")
      .select("id, patient_id")
      .is("sent_at", null)
      .is("abandoned_at", null)
      .lte("scheduled_for", nowIso),
    sb.from("concierge_form_dispatches")
      .select("id, patient_id, sent_at")
      .is("completed_at", null)
      .is("abandoned_at", null)
      .eq("reminder_count", 0)
      .not("sent_at", "is", null)
      .lte("sent_at", cutoff48Iso),
    sb.from("concierge_form_dispatches")
      .select("id, patient_id, sent_at")
      .is("completed_at", null)
      .is("abandoned_at", null)
      .eq("reminder_count", 1)
      .not("sent_at", "is", null)
      .lte("sent_at", cutoff7dIso)
  ])

  let pushed = 0

  for (const row of initial.data ?? []) {
    const ok = await pushToConcierge(env, {
      type: "form_dispatch",
      patient_id: row.patient_id,
      dispatch_id: row.id
    })
    if (!ok) continue
    await sb.rpc("mark_concierge_form_sent", { p_dispatch_id: row.id, p_is_reminder: false })
    pushed += 1
  }

  for (const row of [...(fortyEight.data ?? []), ...(sevenDay.data ?? [])]) {
    const ok = await pushToConcierge(env, {
      type: "form_dispatch",
      patient_id: row.patient_id,
      dispatch_id: row.id
    })
    if (!ok) continue
    await sb.rpc("mark_concierge_form_sent", { p_dispatch_id: row.id, p_is_reminder: true })
    pushed += 1
  }

  return { pushed }
}

export async function markAbandoned(env: Env): Promise<{ abandoned: number }> {
  const { data, error } = await serviceClient(env).rpc("abandon_stale_concierge_dispatches")
  if (error) {
    console.error("abandon_stale_concierge_dispatches", error.message)
    return { abandoned: 0 }
  }
  return { abandoned: (data as number) ?? 0 }
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-"
function randomShortId(): string {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    out += ALPHABET[bytes[i]! & 63]
  }
  return out
}
