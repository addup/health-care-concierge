import type { Env } from "./env"
import { patientClient } from "./supabase"
import { sendMessage, sendChatAction, type ReplyMarkup } from "./telegram"
import { t, type Locale } from "./i18n"
import { putShortId, getShortId } from "./short-id"
import { logAction } from "./audit"

export interface BookingState {
  step: "ask_specialty" | "ask_type" | "ask_date" | "ask_slot"
  specialty_id?: string
  specialty_name?: string
  appointment_type_id?: string
  appointment_type_name?: string
  duration_min?: number
  target_date?: string  // YYYY-MM-DD
}

interface AuthCtx {
  patient_id: string
  access_token: string
}

interface SlotBlob {
  time: string         // "HH:MM"
  doctor_id: string
  doctor_name: string
}

const STORAGE_KEY = "booking_state"

// ---------------------------------------------------------------------
// Entry point — called when intent BOOK is detected.
// ---------------------------------------------------------------------

export async function startBooking(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  specialtyHint?: string | null
): Promise<void> {
  await storage.delete(STORAGE_KEY)
  await sendChatAction(env, chat_id, "typing")
  const sb = patientClient(env, auth.access_token)

  const { data: specialties, error } = await sb
    .from("specialties")
    .select("id, name")
    .eq("is_active", true)
    .order("name")

  if (error || !specialties) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    return
  }
  if (specialties.length === 0) {
    await sendMessage(env, chat_id, t(locale, "booking_no_specialties"))
    return
  }

  // Heuristic: if the LLM extracted a specialty hint and it matches one of
  // the active specialties (case-insensitive substring), skip the picker.
  const hit = specialtyHint
    ? specialties.find((s) => s.name.toLowerCase() === specialtyHint.toLowerCase()) ??
      specialties.find((s) => s.name.toLowerCase().includes(specialtyHint.toLowerCase()))
    : undefined

  if (hit) {
    await proceedToTypeStep(env, storage, chat_id, locale, auth, hit.id, hit.name)
    return
  }

  await storage.put<BookingState>(STORAGE_KEY, { step: "ask_specialty" })
  const buttons: ReplyMarkup = {
    inline_keyboard: specialties.map((s) => [{ text: s.name, callback_data: `s:${s.id}` }])
  }
  await sendMessage(env, chat_id, t(locale, "booking_ask_specialty"), buttons)
}

// ---------------------------------------------------------------------
// Step 2 — specialty chosen, list appointment_types.
// ---------------------------------------------------------------------

export async function handleSpecialtyChoice(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  specialty_id: string
): Promise<void> {
  const sb = patientClient(env, auth.access_token)
  const { data: spec } = await sb
    .from("specialties")
    .select("id, name")
    .eq("id", specialty_id)
    .maybeSingle()
  const specialty_name = spec?.name ?? ""

  await proceedToTypeStep(env, storage, chat_id, locale, auth, specialty_id, specialty_name)
}

async function proceedToTypeStep(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  specialty_id: string,
  specialty_name: string
): Promise<void> {
  await sendChatAction(env, chat_id, "typing")
  const sb = patientClient(env, auth.access_token)
  const { data: types, error } = await sb
    .from("appointment_types")
    .select("id, name, default_duration_min")
    .eq("specialty_id", specialty_id)
    .eq("is_active", true)
    .order("name")

  if (error || !types) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    return
  }
  if (types.length === 0) {
    await sendMessage(env, chat_id, t(locale, "booking_no_types"))
    return
  }

  if (types.length === 1) {
    const only = types[0]!
    await proceedToDateStep(env, storage, chat_id, locale, {
      step: "ask_date",
      specialty_id,
      specialty_name,
      appointment_type_id: only.id,
      appointment_type_name: only.name,
      duration_min: only.default_duration_min
    })
    return
  }

  await storage.put<BookingState>(STORAGE_KEY, {
    step: "ask_type",
    specialty_id,
    specialty_name
  })
  const buttons: ReplyMarkup = {
    inline_keyboard: types.map((tp) => [{ text: tp.name, callback_data: `t:${tp.id}` }])
  }
  await sendMessage(env, chat_id, t(locale, "booking_ask_type"), buttons)
}

// ---------------------------------------------------------------------
// Step 3 — type chosen → ask date.
// ---------------------------------------------------------------------

export async function handleTypeChoice(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  appointment_type_id: string
): Promise<void> {
  const prev = (await storage.get<BookingState>(STORAGE_KEY)) ?? { step: "ask_type" }
  const sb = patientClient(env, auth.access_token)
  const { data: tp } = await sb
    .from("appointment_types")
    .select("id, name, default_duration_min, specialty_id")
    .eq("id", appointment_type_id)
    .maybeSingle()
  if (!tp) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    return
  }
  await proceedToDateStep(env, storage, chat_id, locale, {
    ...prev,
    step: "ask_date",
    specialty_id: prev.specialty_id ?? tp.specialty_id,
    appointment_type_id: tp.id,
    appointment_type_name: tp.name,
    duration_min: tp.default_duration_min
  })
}

async function proceedToDateStep(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  state: BookingState
): Promise<void> {
  await storage.put(STORAGE_KEY, state)
  const today = new Date()
  const buttons: ReplyMarkup = {
    inline_keyboard: []
  }
  for (let i = 0; i < 6; i++) {
    const d = new Date(today)
    d.setUTCDate(today.getUTCDate() + i)
    const iso = d.toISOString().slice(0, 10) // YYYY-MM-DD
    const label =
      i === 0
        ? t(locale, "date_today")
        : i === 1
          ? t(locale, "date_tomorrow")
          : `${dowLabel(locale, d.getUTCDay())} ${d.getUTCDate()}`
    buttons.inline_keyboard!.push([{ text: label, callback_data: `d:${iso}` }])
  }
  await sendMessage(env, chat_id, t(locale, "booking_ask_date"), buttons)
}

// ---------------------------------------------------------------------
// Step 4 — date chosen → list slots.
// ---------------------------------------------------------------------

export async function handleDateChoice(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  iso_date: string
): Promise<void> {
  const prev = await storage.get<BookingState>(STORAGE_KEY)
  if (!prev?.appointment_type_id) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    return
  }
  await renderSlots(env, storage, chat_id, locale, auth, {
    ...prev,
    step: "ask_slot",
    target_date: iso_date
  })
}

async function renderSlots(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  state: BookingState
): Promise<void> {
  await sendChatAction(env, chat_id, "typing")
  await storage.put(STORAGE_KEY, state)

  const sb = patientClient(env, auth.access_token)
  const { data: slotsRaw, error } = await sb.rpc("get_available_slots", {
    _appointment_type_id: state.appointment_type_id!,
    _target_date: state.target_date!
  })
  if (error || !slotsRaw) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    return
  }

  const slots = (slotsRaw as unknown[]).filter(isSlotBlob).slice(0, 6)
  const dateLabel = formatDate(locale, state.target_date!)

  if (slots.length === 0) {
    await sendMessage(env, chat_id, t(locale, "booking_no_slots", { date: dateLabel }))
    // Re-prompt for a different day.
    await proceedToDateStep(env, storage, chat_id, locale, { ...state, step: "ask_date" })
    return
  }

  // Encode each slot blob behind a 10-char short id (ttl 30 min).
  const buttons: ReplyMarkup = { inline_keyboard: [] }
  for (const slot of slots) {
    const short = await putShortId(env, slot)
    const label = `${slot.time} · ${slot.doctor_name}`
    buttons.inline_keyboard!.push([{ text: label, callback_data: `b:${short}` }])
  }

  await sendMessage(
    env,
    chat_id,
    t(locale, "booking_ask_slot", { date: dateLabel }),
    buttons
  )
}

// ---------------------------------------------------------------------
// Step 5 — slot chosen → check + INSERT.
// ---------------------------------------------------------------------

export async function handleSlotChoice(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  short_id: string
): Promise<void> {
  const state = await storage.get<BookingState>(STORAGE_KEY)
  if (!state?.appointment_type_id || !state.target_date || !state.duration_min) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    return
  }
  const slot = await getShortId<SlotBlob>(env, short_id)
  if (!slot) {
    // KV expired — re-list.
    await sendMessage(env, chat_id, t(locale, "booking_slot_taken"))
    await renderSlots(env, storage, chat_id, locale, auth, state)
    return
  }

  await sendChatAction(env, chat_id, "typing")
  const scheduled_at_iso = `${state.target_date}T${slot.time}:00Z`
  const sb = patientClient(env, auth.access_token)

  // Race-check: someone might have grabbed the slot since we listed it.
  const { data: ok } = await sb.rpc("check_slot_available", {
    _doctor_id: slot.doctor_id,
    _scheduled_at: scheduled_at_iso,
    _duration_min: state.duration_min
  })
  if (ok === false) {
    await sendMessage(env, chat_id, t(locale, "booking_slot_taken"))
    await renderSlots(env, storage, chat_id, locale, auth, state)
    return
  }

  const { data: inserted, error } = await sb
    .from("appointments")
    .insert({
      patient_id: auth.patient_id,
      doctor_id: slot.doctor_id,
      appointment_type_id: state.appointment_type_id,
      scheduled_at: scheduled_at_iso,
      duration_min: state.duration_min,
      status: "scheduled"
    })
    .select("id")
    .single()

  if (error || !inserted) {
    await sendMessage(env, chat_id, t(locale, "booking_failed"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "BOOK",
      action: "book_failed",
      payload: { error: error?.message ?? "unknown" }
    })
    return
  }

  await storage.delete(STORAGE_KEY)
  await logAction(env, {
    patient_id: auth.patient_id,
    telegram_user_id: chat_id,
    intent: "BOOK",
    action: "book_succeeded",
    payload: {
      appointment_id: inserted.id,
      appointment_type_id: state.appointment_type_id,
      doctor_id: slot.doctor_id,
      scheduled_at: scheduled_at_iso
    }
  })

  const when = `${formatDate(locale, state.target_date)} ${slot.time}`
  await sendMessage(env, chat_id, t(locale, "booking_confirmed", {
    type: state.appointment_type_name ?? "",
    doctor: slot.doctor_name,
    when
  }))
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function isSlotBlob(v: unknown): v is SlotBlob {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.time === "string" &&
    typeof o.doctor_id === "string" &&
    typeof o.doctor_name === "string"
  )
}

function dowLabel(locale: Locale, dow: number): string {
  const key = `date_dow_${dow}` as
    | "date_dow_0"
    | "date_dow_1"
    | "date_dow_2"
    | "date_dow_3"
    | "date_dow_4"
    | "date_dow_5"
    | "date_dow_6"
  return t(locale, key)
}

function formatDate(locale: Locale, iso: string): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10))
  if (!y || !m || !d) return iso
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = dowLabel(locale, date.getUTCDay())
  return `${dow} ${d}/${m}`
}
