import type { Env } from "./env"
import { serviceClient } from "./supabase"
import { pushToConcierge } from "./forwarder"
import { reminder24hText, type Locale } from "./i18n"

const HOUR_MS = 60 * 60 * 1000

/**
 * Find appointments scheduled in [now+23h, now+25h] that haven't had a
 * 24h reminder sent yet, push the reminder, and bookkeep.
 */
export async function send24hReminders(env: Env): Promise<{ sent: number; checked: number }> {
  const sb = serviceClient(env)
  const now = Date.now()
  const fromIso = new Date(now + 23 * HOUR_MS).toISOString()
  const toIso = new Date(now + 25 * HOUR_MS).toISOString()

  const { data: appts, error } = await sb
    .from("appointments")
    .select("id, scheduled_at, doctor_id, patient_id, appointment_type_id, appointment_types(name)")
    .gte("scheduled_at", fromIso)
    .lte("scheduled_at", toIso)
    .in("status", ["scheduled", "confirmed"])

  if (error || !appts || appts.length === 0) {
    return { sent: 0, checked: appts?.length ?? 0 }
  }

  const apptIds = appts.map((a) => a.id)
  const [{ data: states }, { data: links }, { data: doctorProfiles }] = await Promise.all([
    sb.from("concierge_appointment_state")
      .select("appointment_id, reminder_sent_at")
      .in("appointment_id", apptIds),
    sb.from("concierge_telegram_links")
      .select("patient_id, locale")
      .in("patient_id", appts.map((a) => a.patient_id)),
    sb.from("profiles")
      .select("id, chosen_name")
      .in("id", appts.map((a) => a.doctor_id))
  ])

  const reminded = new Set(
    (states ?? []).filter((s) => s.reminder_sent_at).map((s) => s.appointment_id)
  )
  const linkedLocale = new Map(
    (links ?? []).map((l) => [l.patient_id, (l.locale === "en" ? "en" : "pt") as Locale])
  )
  const docName = new Map(
    (doctorProfiles ?? []).map((d) => [d.id, d.chosen_name ?? ""])
  )

  let sent = 0
  for (const a of appts) {
    if (reminded.has(a.id)) continue
    // Only patients linked via Telegram get a bot reminder.
    const locale = linkedLocale.get(a.patient_id)
    if (!locale) continue

    const when = new Date(a.scheduled_at)
    const hhmm = `${String(when.getUTCHours()).padStart(2, "0")}:${String(when.getUTCMinutes()).padStart(2, "0")}`
    const typeName =
      (a.appointment_types as { name?: string } | null)?.name ?? "Consulta"
    const doctor = docName.get(a.doctor_id) ?? ""

    const text = reminder24hText(locale, { hhmm, type: typeName, doctor })

    const ok = await pushToConcierge(env, {
      type: "reminder",
      patient_id: a.patient_id,
      text
    })
    if (!ok) continue

    await sb.rpc("concierge_set_appointment_state", {
      p_appointment_id: a.id,
      p_field: "reminder_sent_at",
      p_value: new Date().toISOString()
    })
    sent += 1
  }

  return { sent, checked: appts.length }
}
