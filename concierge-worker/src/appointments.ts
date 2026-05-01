import type { Env } from "./env"
import { patientClient } from "./supabase"
import { sendMessage, sendChatAction, type ReplyMarkup } from "./telegram"
import { t, type Locale } from "./i18n"
import { putShortId, getShortId } from "./short-id"
import { logAction } from "./audit"

interface AuthCtx {
  patient_id: string
  access_token: string
}

interface ApptRow {
  id: string
  scheduled_at: string
  duration_min: number
  doctor_id: string
  appointment_type_id: string | null
  appointment_type_name: string | null
}

interface RescheduleState {
  step: "ask_date" | "ask_slot"
  appointment_id: string
  appointment_type_id: string
  duration_min: number
  target_date?: string
}

interface CancelState {
  appointment_id: string
  when_label: string
  type_label: string
}

const RESCHEDULE_KEY = "reschedule_state"
const CANCEL_KEY = "cancel_state"

// ---------------------------------------------------------------------
// Shared list query
// ---------------------------------------------------------------------

async function fetchUpcoming(
  env: Env,
  auth: AuthCtx,
  limit = 10
): Promise<{ rows: ApptRow[]; doctorNames: Map<string, string> }> {
  const sb = patientClient(env, auth.access_token)
  const nowIso = new Date().toISOString()

  const { data: rawRows } = await sb
    .from("appointments")
    .select("id, scheduled_at, duration_min, doctor_id, appointment_type_id, appointment_types(name)")
    .eq("patient_id", auth.patient_id)
    .in("status", ["scheduled", "confirmed"])
    .gte("scheduled_at", nowIso)
    .order("scheduled_at")
    .limit(limit)

  if (!rawRows || rawRows.length === 0) {
    return { rows: [], doctorNames: new Map() }
  }

  const rows: ApptRow[] = rawRows.map((r) => ({
    id: r.id,
    scheduled_at: r.scheduled_at,
    duration_min: r.duration_min,
    doctor_id: r.doctor_id,
    appointment_type_id: r.appointment_type_id,
    // appointment_types is an embedded relationship; supabase-js types it as
    // an object | null when using PostgREST's resource embedding.
    appointment_type_name:
      (r.appointment_types as { name?: string } | null)?.name ?? null
  }))

  const doctorIds = Array.from(new Set(rows.map((r) => r.doctor_id)))
  const { data: docs } = await sb
    .from("profiles")
    .select("id, chosen_name")
    .in("id", doctorIds)
  const doctorNames = new Map<string, string>(
    (docs ?? []).map((d) => [d.id, d.chosen_name ?? ""])
  )

  return { rows, doctorNames }
}

function dowLabel(locale: Locale, dow: number): string {
  return t(locale, `date_dow_${dow}` as
    | "date_dow_0" | "date_dow_1" | "date_dow_2" | "date_dow_3"
    | "date_dow_4" | "date_dow_5" | "date_dow_6")
}

function whenLabel(locale: Locale, iso: string): string {
  const d = new Date(iso)
  const dow = dowLabel(locale, d.getUTCDay())
  const day = d.getUTCDate()
  const month = d.getUTCMonth() + 1
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mm = String(d.getUTCMinutes()).padStart(2, "0")
  return `${dow} ${day}/${month} ${hh}:${mm}`
}

// ---------------------------------------------------------------------
// LIST_APPOINTMENTS
// ---------------------------------------------------------------------

export async function listMyAppointments(
  env: Env,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx
): Promise<void> {
  await sendChatAction(env, chat_id, "typing")
  const { rows, doctorNames } = await fetchUpcoming(env, auth)
  if (rows.length === 0) {
    await sendMessage(env, chat_id, t(locale, "list_empty"))
    return
  }
  const lines = [t(locale, "list_header")]
  for (const r of rows) {
    lines.push(
      t(locale, "appt_line", {
        when: whenLabel(locale, r.scheduled_at),
        type: r.appointment_type_name ?? "—",
        doctor: doctorNames.get(r.doctor_id) ?? ""
      })
    )
  }
  await sendMessage(env, chat_id, lines.join("\n"))
}

// ---------------------------------------------------------------------
// RESCHEDULE — ask which appointment, then date, then slot.
// ---------------------------------------------------------------------

export async function startReschedule(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx
): Promise<void> {
  await storage.delete(RESCHEDULE_KEY)
  await sendChatAction(env, chat_id, "typing")
  const { rows, doctorNames } = await fetchUpcoming(env, auth)
  if (rows.length === 0) {
    await sendMessage(env, chat_id, t(locale, "manage_no_upcoming"))
    return
  }

  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const r of rows) {
    const label = `${whenLabel(locale, r.scheduled_at)} — ${r.appointment_type_name ?? "—"}`
    const short = await putShortId(env, {
      id: r.id,
      appointment_type_id: r.appointment_type_id,
      duration_min: r.duration_min,
      scheduled_at: r.scheduled_at,
      doctor_id: r.doctor_id,
      appointment_type_name: r.appointment_type_name,
      doctor_name: doctorNames.get(r.doctor_id) ?? ""
    })
    inline_keyboard.push([{ text: label, callback_data: `rp:${short}` }])
  }
  await sendMessage(
    env,
    chat_id,
    t(locale, "manage_pick_appt_reschedule"),
    { inline_keyboard }
  )
}

export async function handleReschedulePick(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  _auth: AuthCtx,
  short: string
): Promise<void> {
  const blob = await getShortId<{
    id: string
    appointment_type_id: string | null
    duration_min: number
  }>(env, short)
  if (!blob || !blob.appointment_type_id) {
    await sendMessage(env, chat_id, t(locale, "reschedule_failed"))
    return
  }
  const state: RescheduleState = {
    step: "ask_date",
    appointment_id: blob.id,
    appointment_type_id: blob.appointment_type_id,
    duration_min: blob.duration_min
  }
  await storage.put(RESCHEDULE_KEY, state)
  await renderRescheduleDates(env, chat_id, locale)
}

async function renderRescheduleDates(
  env: Env,
  chat_id: number,
  locale: Locale
): Promise<void> {
  const today = new Date()
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(today)
    d.setUTCDate(today.getUTCDate() + i)
    const iso = d.toISOString().slice(0, 10)
    const label =
      i === 0
        ? t(locale, "date_today")
        : i === 1
          ? t(locale, "date_tomorrow")
          : `${dowLabel(locale, d.getUTCDay())} ${d.getUTCDate()}`
    inline_keyboard.push([{ text: label, callback_data: `rd:${iso}` }])
  }
  await sendMessage(env, chat_id, t(locale, "booking_ask_date"), { inline_keyboard })
}

export async function handleRescheduleDate(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  iso_date: string
): Promise<void> {
  const state = await storage.get<RescheduleState>(RESCHEDULE_KEY)
  if (!state) {
    await sendMessage(env, chat_id, t(locale, "reschedule_failed"))
    return
  }
  await sendChatAction(env, chat_id, "typing")
  const sb = patientClient(env, auth.access_token)
  const { data: slotsRaw, error } = await sb.rpc("get_available_slots", {
    _appointment_type_id: state.appointment_type_id,
    _target_date: iso_date
  })
  if (error || !slotsRaw) {
    await sendMessage(env, chat_id, t(locale, "reschedule_failed"))
    return
  }
  const slots = (slotsRaw as unknown[]).filter(isSlotBlob).slice(0, 6)
  const dateLabel = formatDate(locale, iso_date)
  if (slots.length === 0) {
    await sendMessage(env, chat_id, t(locale, "booking_no_slots", { date: dateLabel }))
    await renderRescheduleDates(env, chat_id, locale)
    return
  }
  await storage.put(RESCHEDULE_KEY, { ...state, step: "ask_slot", target_date: iso_date })
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const slot of slots) {
    const short = await putShortId(env, slot)
    inline_keyboard.push([{ text: `${slot.time} · ${slot.doctor_name}`, callback_data: `rs:${short}` }])
  }
  await sendMessage(env, chat_id, t(locale, "booking_ask_slot", { date: dateLabel }), {
    inline_keyboard
  })
}

export async function handleRescheduleSlot(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  short: string
): Promise<void> {
  const state = await storage.get<RescheduleState>(RESCHEDULE_KEY)
  if (!state || !state.target_date) {
    await sendMessage(env, chat_id, t(locale, "reschedule_failed"))
    return
  }
  const slot = await getShortId<{ time: string; doctor_id: string; doctor_name: string }>(env, short)
  if (!slot) {
    await sendMessage(env, chat_id, t(locale, "booking_slot_taken"))
    await handleRescheduleDate(env, storage, chat_id, locale, auth, state.target_date)
    return
  }

  const sb = patientClient(env, auth.access_token)
  const scheduled_at_iso = `${state.target_date}T${slot.time}:00Z`

  const { data: ok } = await sb.rpc("check_slot_available", {
    _doctor_id: slot.doctor_id,
    _scheduled_at: scheduled_at_iso,
    _duration_min: state.duration_min
  })
  if (ok === false) {
    await sendMessage(env, chat_id, t(locale, "booking_slot_taken"))
    await handleRescheduleDate(env, storage, chat_id, locale, auth, state.target_date)
    return
  }

  const { error } = await sb
    .from("appointments")
    .update({
      scheduled_at: scheduled_at_iso,
      doctor_id: slot.doctor_id
    })
    .eq("id", state.appointment_id)
    .eq("patient_id", auth.patient_id)

  if (error) {
    await sendMessage(env, chat_id, t(locale, "reschedule_failed"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "RESCHEDULE",
      action: "reschedule_failed",
      payload: { error: error.message }
    })
    return
  }

  await storage.delete(RESCHEDULE_KEY)
  await logAction(env, {
    patient_id: auth.patient_id,
    telegram_user_id: chat_id,
    intent: "RESCHEDULE",
    action: "reschedule_succeeded",
    payload: {
      appointment_id: state.appointment_id,
      new_scheduled_at: scheduled_at_iso,
      new_doctor_id: slot.doctor_id
    }
  })
  await sendMessage(
    env,
    chat_id,
    t(locale, "reschedule_done", { when: `${formatDate(locale, state.target_date)} ${slot.time}` })
  )
}

// ---------------------------------------------------------------------
// CANCEL — pick appointment → confirm yes/no → UPDATE status.
// ---------------------------------------------------------------------

export async function startCancel(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx
): Promise<void> {
  await storage.delete(CANCEL_KEY)
  await sendChatAction(env, chat_id, "typing")
  const { rows, doctorNames } = await fetchUpcoming(env, auth)
  if (rows.length === 0) {
    await sendMessage(env, chat_id, t(locale, "manage_no_upcoming"))
    return
  }
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const r of rows) {
    const when = whenLabel(locale, r.scheduled_at)
    const type = r.appointment_type_name ?? "—"
    const short = await putShortId(env, {
      id: r.id,
      when_label: when,
      type_label: type,
      doctor_label: doctorNames.get(r.doctor_id) ?? ""
    })
    inline_keyboard.push([{ text: `${when} — ${type}`, callback_data: `xp:${short}` }])
  }
  await sendMessage(env, chat_id, t(locale, "manage_pick_appt_cancel"), { inline_keyboard })
}

export async function handleCancelPick(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  _auth: AuthCtx,
  short: string
): Promise<void> {
  const blob = await getShortId<{
    id: string
    when_label: string
    type_label: string
  }>(env, short)
  if (!blob) {
    await sendMessage(env, chat_id, t(locale, "cancel_failed"))
    return
  }
  const state: CancelState = {
    appointment_id: blob.id,
    when_label: blob.when_label,
    type_label: blob.type_label
  }
  await storage.put(CANCEL_KEY, state)
  // Confirmation prompt with yes/no buttons. Fits in 64 bytes easily.
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = [
    [{ text: t(locale, "cancel_confirm_yes"), callback_data: `xc:1` }],
    [{ text: t(locale, "cancel_confirm_no"), callback_data: `xc:0` }]
  ]
  await sendMessage(
    env,
    chat_id,
    t(locale, "cancel_confirm_prompt", { when: blob.when_label, type: blob.type_label }),
    { inline_keyboard }
  )
}

export async function handleCancelConfirm(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  decision: "0" | "1"
): Promise<void> {
  const state = await storage.get<CancelState>(CANCEL_KEY)
  if (!state) {
    await sendMessage(env, chat_id, t(locale, "cancel_failed"))
    return
  }
  if (decision === "0") {
    await storage.delete(CANCEL_KEY)
    await sendMessage(env, chat_id, t(locale, "cancel_kept"))
    return
  }
  const sb = patientClient(env, auth.access_token)
  const { error } = await sb
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", state.appointment_id)
    .eq("patient_id", auth.patient_id)
  if (error) {
    await sendMessage(env, chat_id, t(locale, "cancel_failed"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "CANCEL",
      action: "cancel_failed",
      payload: { appointment_id: state.appointment_id, error: error.message }
    })
    return
  }
  await storage.delete(CANCEL_KEY)
  await logAction(env, {
    patient_id: auth.patient_id,
    telegram_user_id: chat_id,
    intent: "CANCEL",
    action: "cancel_succeeded",
    payload: { appointment_id: state.appointment_id }
  })
  await sendMessage(env, chat_id, t(locale, "cancel_done"))
}

// ---------------------------------------------------------------------
// Helpers (duplicated tiny bit from booking.ts for now)
// ---------------------------------------------------------------------

function isSlotBlob(v: unknown): v is { time: string; doctor_id: string; doctor_name: string } {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.time === "string" &&
    typeof o.doctor_id === "string" &&
    typeof o.doctor_name === "string"
  )
}

function formatDate(locale: Locale, iso: string): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10))
  if (!y || !m || !d) return iso
  const date = new Date(Date.UTC(y, m - 1, d))
  return `${dowLabel(locale, date.getUTCDay())} ${d}/${m}`
}
