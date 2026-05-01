/**
 * One-shot demo seed.
 *
 * Run AFTER:
 *   - the platform's main seed has populated specialties, doctors,
 *     doctor_specialties, and appointment_types
 *   - supabase/migrations/20260501120000_concierge.sql has been applied
 *
 * Usage:
 *   cd scripts
 *   cp .env.example .env     # fill in SUPABASE_URL + SUPABASE_SERVICE_KEY
 *   npm install
 *   npm run seed
 *
 * What it does:
 *   1) Creates 10 patient auth.users (supabase.auth.admin.createUser),
 *      then UPDATEs the resulting `profiles` rows so each is a fully
 *      registered patient.
 *   2) Inserts the concierge_telegram_links rows so the scheduler-worker
 *      can address all of them (telegram_user_ids 1000000001..010 are
 *      synthetic — only one corresponds to a real Telegram chat in the
 *      live demo, which is fine: pushes to the others fail silently).
 *   3) For each patient, inserts past `appointments` rows back-dated
 *      according to the narrative segment, plus matching
 *      concierge_form_dispatches and concierge_form_responses.
 *
 * Idempotent: re-running deletes prior concierge_demo_* rows and
 * re-inserts. Auth users are upserted via createUser (returns the
 * existing one when already present).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import process from "node:process"

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (see .env.example)")
  process.exit(1)
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

// ---------------------------------------------------------------------
// Patient roster + narrative
// ---------------------------------------------------------------------

type Segment = "healthy" | "improving" | "deteriorating" | "critical_prem" | "non_responder"

interface Patient {
  id: string
  email: string
  chosen_name: string
  phone: string
  telegram_user_id: number
  segment: Segment
}

const uuid = (n: number): string =>
  `11111111-1111-1111-1111-111100000${n.toString().padStart(3, "0")}`

const PATIENTS: Patient[] = [
  // healthy (NPS 9-10, EQ-5D index ~0.88+)
  { id: uuid(1), email: "alice.costa@example.com",      chosen_name: "Alice Costa",     phone: "+351911000001", telegram_user_id: 1000000001, segment: "healthy" },
  { id: uuid(2), email: "bruno.silva@example.com",      chosen_name: "Bruno Silva",     phone: "+351911000002", telegram_user_id: 1000000002, segment: "healthy" },
  { id: uuid(3), email: "catarina.lopes@example.com",   chosen_name: "Catarina Lopes",  phone: "+351911000003", telegram_user_id: 1000000003, segment: "healthy" },
  // improving (rising EQ-5D, rising NPS)
  { id: uuid(4), email: "diogo.marques@example.com",    chosen_name: "Diogo Marques",   phone: "+351911000004", telegram_user_id: 1000000004, segment: "improving" },
  { id: uuid(5), email: "elsa.pereira@example.com",     chosen_name: "Elsa Pereira",    phone: "+351911000005", telegram_user_id: 1000000005, segment: "improving" },
  { id: uuid(6), email: "filipe.tavares@example.com",   chosen_name: "Filipe Tavares",  phone: "+351911000006", telegram_user_id: 1000000006, segment: "improving" },
  // deteriorating (falling EQ-5D, anxiety/depression worsening)
  { id: uuid(7), email: "gabriela.sousa@example.com",   chosen_name: "Gabriela Sousa",  phone: "+351911000007", telegram_user_id: 1000000007, segment: "deteriorating" },
  { id: uuid(8), email: "henrique.dias@example.com",    chosen_name: "Henrique Dias",   phone: "+351911000008", telegram_user_id: 1000000008, segment: "deteriorating" },
  // critical PREM (NPS=3, negative comment)
  { id: uuid(9), email: "ines.faria@example.com",       chosen_name: "Inês Faria",      phone: "+351911000009", telegram_user_id: 1000000009, segment: "critical_prem" },
  // non-responder (recent appt, dispatch sent but never completed)
  { id: uuid(10), email: "joao.ribeiro@example.com",    chosen_name: "João Ribeiro",    phone: "+351911000010", telegram_user_id: 1000000010, segment: "non_responder" }
]

// ---------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------

async function ensurePatients(): Promise<void> {
  for (const p of PATIENTS) {
    // createUser is idempotent: returns the existing user when the email
    // already exists in auth.users.
    const { data, error } = await sb.auth.admin.createUser({
      id: p.id,
      email: p.email,
      email_confirm: true,
      phone: p.phone,
      user_metadata: { chosen_name: p.chosen_name, preferred_language: "pt" }
    } as never)
    if (error && !/already registered|exists/i.test(error.message)) {
      throw new Error(`createUser ${p.email}: ${error.message}`)
    }
    const userId = data?.user?.id ?? p.id

    // Bring the profiles row into the registered-patient state.
    const { error: pe } = await sb
      .from("profiles")
      .update({
        role: "patient",
        registration_completed: true,
        accepted_terms_version: "v1",
        chosen_name: p.chosen_name,
        legal_name: p.chosen_name,
        email: p.email,
        phone: p.phone,
        preferred_language: "pt"
      })
      .eq("id", userId)
    if (pe) throw new Error(`profiles update ${p.email}: ${pe.message}`)
    console.log(`✓ patient ${p.chosen_name}`)
  }
}

async function ensureTelegramLinks(): Promise<void> {
  for (const p of PATIENTS) {
    const { error } = await sb.rpc("concierge_link_telegram", {
      p_telegram_user_id: p.telegram_user_id,
      p_patient_id: p.id,
      p_locale: "pt"
    })
    if (error) throw new Error(`link_telegram ${p.email}: ${error.message}`)
  }
  console.log(`✓ ${PATIENTS.length} telegram links`)
}

interface AppointmentTypeRow {
  id: string
  name: string
  default_duration_min: number
  specialty_id: string
  specialty_name: string | null
}

async function loadAppointmentTypes(): Promise<AppointmentTypeRow[]> {
  const { data, error } = await sb
    .from("appointment_types")
    .select("id, name, default_duration_min, specialty_id, specialties(name)")
    .eq("is_active", true)
  if (error) throw error
  return (data ?? []).map((r) => {
    // The embed comes back as either an object or array depending on
    // PostgREST relationship inference. Handle both shapes.
    const sp = (r as { specialties?: unknown }).specialties
    let specialty_name: string | null = null
    if (Array.isArray(sp) && sp.length > 0 && typeof (sp[0] as { name?: string })?.name === "string") {
      specialty_name = (sp[0] as { name: string }).name
    } else if (sp && typeof sp === "object" && "name" in sp && typeof (sp as { name?: string }).name === "string") {
      specialty_name = (sp as { name: string }).name
    }
    return {
      id: r.id as string,
      name: r.name as string,
      default_duration_min: r.default_duration_min as number,
      specialty_id: r.specialty_id as string,
      specialty_name
    }
  })
}

async function loadDoctorBySpecialty(specialty_id: string): Promise<string | null> {
  const { data } = await sb
    .from("doctor_specialties")
    .select("doctor_id")
    .eq("specialty_id", specialty_id)
    .limit(1)
    .maybeSingle()
  return data?.doctor_id ?? null
}

async function clearPriorDemoData(): Promise<void> {
  // Wipe concierge demo rows belonging to our 10 patients (in order).
  const ids = PATIENTS.map((p) => p.id)
  await sb.from("concierge_form_responses").delete().in("patient_id", ids)
  await sb.from("concierge_form_dispatches").delete().in("patient_id", ids)
  await sb.from("concierge_appointment_state").delete().in(
    "appointment_id",
    (await sb.from("appointments").select("id").in("patient_id", ids)).data?.map(r => r.id) ?? []
  )
  await sb.from("appointments").delete().in("patient_id", ids)
  console.log("✓ cleared prior concierge demo data")
}

// ---------------------------------------------------------------------
// Narrative dispatcher
// ---------------------------------------------------------------------

interface InsertedAppt {
  id: string
  patient_id: string
  scheduled_at: string
  duration_min: number
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-"
function shortId(): string {
  const out: string[] = []
  for (let i = 0; i < 10; i++) {
    out.push(ALPHABET[Math.floor(Math.random() * 64)]!)
  }
  return out.join("")
}

function isoDaysAgo(days: number, hh = 9, mm = 30): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(hh, mm, 0, 0)
  return d.toISOString()
}

function isoDaysFromNow(days: number, hh = 9, mm = 30): string {
  return isoDaysAgo(-days, hh, mm)
}

async function insertAppointment(args: {
  patient_id: string
  doctor_id: string
  appointment_type_id: string
  scheduled_at: string
  duration_min: number
  status: "scheduled" | "completed"
}): Promise<InsertedAppt> {
  const { data, error } = await sb
    .from("appointments")
    .insert(args)
    .select("id, patient_id, scheduled_at, duration_min")
    .single()
  if (error || !data) throw new Error(`insert appointment: ${error?.message}`)
  return data as InsertedAppt
}

async function dispatchAndRespond(args: {
  appointment_id: string
  patient_id: string
  template_id: "PREM_v1" | "EQ5D5L_v1"
  schedule_label: "PREM_T24h" | "PROM_T7d" | "PROM_T28d"
  scheduled_for: string
  answers: Record<string, number | string>
  score: Record<string, unknown>
  completed_at: string
  state_field: "prem_dispatched_at" | "prom_t7_dispatched_at" | "prom_t28_dispatched_at"
}): Promise<void> {
  const id = shortId()
  await sb.rpc("dispatch_concierge_form", {
    p_id: id,
    p_appointment_id: args.appointment_id,
    p_template_id: args.template_id,
    p_schedule_label: args.schedule_label,
    p_scheduled_for: args.scheduled_for
  })
  // Read back to get whatever id actually landed (in case of conflict).
  const { data: row } = await sb
    .from("concierge_form_dispatches")
    .select("id")
    .eq("appointment_id", args.appointment_id)
    .eq("schedule_label", args.schedule_label)
    .maybeSingle()
  if (!row) throw new Error("dispatch row missing")

  // Mark sent at the same time as scheduled_for, then record response.
  await sb.from("concierge_form_dispatches")
    .update({ sent_at: args.scheduled_for, completed_at: args.completed_at })
    .eq("id", row.id)
  await sb.from("concierge_form_responses").insert({
    dispatch_id: row.id,
    patient_id: args.patient_id,
    template_id: args.template_id,
    answers: args.answers,
    score: args.score,
    completed_at: args.completed_at
  })
  await sb.rpc("concierge_set_appointment_state", {
    p_appointment_id: args.appointment_id,
    p_field: args.state_field,
    p_value: args.scheduled_for
  })
}

async function dispatchOnly(args: {
  appointment_id: string
  patient_id: string
  template_id: "PREM_v1" | "EQ5D5L_v1"
  schedule_label: "PREM_T24h"
  scheduled_for: string
  state_field: "prem_dispatched_at"
}): Promise<void> {
  const id = shortId()
  await sb.rpc("dispatch_concierge_form", {
    p_id: id,
    p_appointment_id: args.appointment_id,
    p_template_id: args.template_id,
    p_schedule_label: args.schedule_label,
    p_scheduled_for: args.scheduled_for
  })
  await sb.from("concierge_form_dispatches")
    .update({ sent_at: args.scheduled_for })  // sent but not completed
    .eq("appointment_id", args.appointment_id)
    .eq("schedule_label", args.schedule_label)
  await sb.rpc("concierge_set_appointment_state", {
    p_appointment_id: args.appointment_id,
    p_field: args.state_field,
    p_value: args.scheduled_for
  })
}

function premScore(nps: number, wait_time: number, communication: number, comment: string | null) {
  const segment = nps >= 9 ? "promoter" : nps >= 7 ? "passive" : "detractor"
  return {
    answers: { nps, wait_time, communication, ...(comment ? { comment } : {}) },
    score: { nps, nps_segment: segment, wait_time, communication, comment }
  }
}

function eq5dScore(profile: string, vas: number, index: number) {
  return {
    answers: {
      mobility:           Number(profile[0]),
      self_care:          Number(profile[1]),
      usual_activities:   Number(profile[2]),
      pain_discomfort:    Number(profile[3]),
      anxiety_depression: Number(profile[4]),
      vas
    },
    score: { profile, eq5d_index: index, vas }
  }
}

// ---------------------------------------------------------------------
// Main seed flow
// ---------------------------------------------------------------------

async function seedNarrative(): Promise<void> {
  const types = await loadAppointmentTypes()
  if (types.length === 0) throw new Error("No active appointment_types — run the platform seed first")

  // Pick a default type per specialty by name. Falls back to whatever is available.
  const byName = (n: string) =>
    types.find((t) => t.specialty_name?.toLowerCase().includes(n)) ?? types[0]!
  const tMG = byName("medicina geral")
  const tNutri = byName("nutri")
  const tPsico = byName("psico")

  const docMG = (await loadDoctorBySpecialty(tMG.specialty_id)) ?? null
  const docNutri = (await loadDoctorBySpecialty(tNutri.specialty_id)) ?? null
  const docPsico = (await loadDoctorBySpecialty(tPsico.specialty_id)) ?? null
  if (!docMG) throw new Error("No doctor for Medicina Geral")

  const safeDoc = (d: string | null) => d ?? docMG  // fallback so seed always works
  const docFor = { healthy: docMG, improving: safeDoc(docNutri), deteriorating: safeDoc(docPsico), critical_prem: docMG, non_responder: docMG }
  const typeFor = { healthy: tMG, improving: tNutri, deteriorating: tPsico, critical_prem: tMG, non_responder: tMG }

  for (const p of PATIENTS) {
    const docId = docFor[p.segment]
    const tp = typeFor[p.segment]
    switch (p.segment) {
      case "healthy": {
        const a1 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(40), duration_min: tp.default_duration_min, status: "completed" })
        const a2 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(15), duration_min: tp.default_duration_min, status: "completed" })
        for (const a of [a1, a2]) {
          await dispatchAndRespond({ appointment_id: a.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h", scheduled_for: isoOffset(a.scheduled_at, 1), completed_at: isoOffset(a.scheduled_at, 1, 2), state_field: "prem_dispatched_at", ...premScore(10, 5, 5, null) })
          await dispatchAndRespond({ appointment_id: a.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T7d", scheduled_for: isoOffset(a.scheduled_at, 7), completed_at: isoOffset(a.scheduled_at, 7, 2), state_field: "prom_t7_dispatched_at", ...eq5dScore("11111", 90, 1.000) })
          await dispatchAndRespond({ appointment_id: a.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T28d", scheduled_for: isoOffset(a.scheduled_at, 28), completed_at: isoOffset(a.scheduled_at, 28, 2), state_field: "prom_t28_dispatched_at", ...eq5dScore("11211", 85, 0.880) })
        }
        break
      }
      case "improving": {
        const a1 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(60), duration_min: tp.default_duration_min, status: "completed" })
        const a2 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(20), duration_min: tp.default_duration_min, status: "completed" })
        // First appt: PREM 6, PROMs 0.55 / 0.62
        await dispatchAndRespond({ appointment_id: a1.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h", scheduled_for: isoOffset(a1.scheduled_at, 1), completed_at: isoOffset(a1.scheduled_at, 1, 2), state_field: "prem_dispatched_at", ...premScore(6, 3, 4, null) })
        await dispatchAndRespond({ appointment_id: a1.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T7d", scheduled_for: isoOffset(a1.scheduled_at, 7), completed_at: isoOffset(a1.scheduled_at, 7, 2), state_field: "prom_t7_dispatched_at", ...eq5dScore("32232", 55, 0.55) })
        await dispatchAndRespond({ appointment_id: a1.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T28d", scheduled_for: isoOffset(a1.scheduled_at, 28), completed_at: isoOffset(a1.scheduled_at, 28, 2), state_field: "prom_t28_dispatched_at", ...eq5dScore("22221", 60, 0.62) })
        // Second appt: PREM 9, PROMs 0.71 / 0.78
        await dispatchAndRespond({ appointment_id: a2.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h", scheduled_for: isoOffset(a2.scheduled_at, 1), completed_at: isoOffset(a2.scheduled_at, 1, 2), state_field: "prem_dispatched_at", ...premScore(9, 4, 5, "Senti melhorias claras.") })
        await dispatchAndRespond({ appointment_id: a2.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T7d", scheduled_for: isoOffset(a2.scheduled_at, 7), completed_at: isoOffset(a2.scheduled_at, 7, 2), state_field: "prom_t7_dispatched_at", ...eq5dScore("21211", 75, 0.71) })
        await dispatchAndRespond({ appointment_id: a2.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T28d", scheduled_for: isoOffset(a2.scheduled_at, 28), completed_at: isoOffset(a2.scheduled_at, 28, 2), state_field: "prom_t28_dispatched_at", ...eq5dScore("11211", 80, 0.78) })
        break
      }
      case "deteriorating": {
        const a1 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(50), duration_min: tp.default_duration_min, status: "completed" })
        const a2 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(15), duration_min: tp.default_duration_min, status: "completed" })
        await dispatchAndRespond({ appointment_id: a1.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h", scheduled_for: isoOffset(a1.scheduled_at, 1), completed_at: isoOffset(a1.scheduled_at, 1, 2), state_field: "prem_dispatched_at", ...premScore(8, 4, 4, null) })
        await dispatchAndRespond({ appointment_id: a1.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T7d", scheduled_for: isoOffset(a1.scheduled_at, 7), completed_at: isoOffset(a1.scheduled_at, 7, 2), state_field: "prom_t7_dispatched_at", ...eq5dScore("11212", 78, 0.78) })
        await dispatchAndRespond({ appointment_id: a1.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T28d", scheduled_for: isoOffset(a1.scheduled_at, 28), completed_at: isoOffset(a1.scheduled_at, 28, 2), state_field: "prom_t28_dispatched_at", ...eq5dScore("12223", 70, 0.70) })
        await dispatchAndRespond({ appointment_id: a2.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h", scheduled_for: isoOffset(a2.scheduled_at, 1), completed_at: isoOffset(a2.scheduled_at, 1, 2), state_field: "prem_dispatched_at", ...premScore(7, 3, 4, null) })
        await dispatchAndRespond({ appointment_id: a2.id, patient_id: p.id, template_id: "EQ5D5L_v1", schedule_label: "PROM_T7d", scheduled_for: isoOffset(a2.scheduled_at, 7), completed_at: isoOffset(a2.scheduled_at, 7, 2), state_field: "prom_t7_dispatched_at", ...eq5dScore("13234", 60, 0.62) })
        break
      }
      case "critical_prem": {
        const a1 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(25), duration_min: tp.default_duration_min, status: "completed" })
        await dispatchAndRespond({
          appointment_id: a1.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h",
          scheduled_for: isoOffset(a1.scheduled_at, 1), completed_at: isoOffset(a1.scheduled_at, 1, 2),
          state_field: "prem_dispatched_at",
          ...premScore(3, 1, 3, "Esperei mais de uma hora, ninguém me avisou. Saí frustrada.")
        })
        break
      }
      case "non_responder": {
        // 1 recent completed appt — PREM dispatched but not completed
        const a1 = await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysAgo(3), duration_min: tp.default_duration_min, status: "completed" })
        await dispatchOnly({ appointment_id: a1.id, patient_id: p.id, template_id: "PREM_v1", schedule_label: "PREM_T24h", scheduled_for: isoDaysAgo(2), state_field: "prem_dispatched_at" })
        // 1 future appt — for the 24h reminder demo
        await insertAppointment({ patient_id: p.id, doctor_id: docId, appointment_type_id: tp.id, scheduled_at: isoDaysFromNow(1, 9, 30), duration_min: tp.default_duration_min, status: "scheduled" })
        break
      }
    }
    console.log(`  • ${p.chosen_name} (${p.segment})`)
  }
}

function isoOffset(baseIso: string, days: number, hourBump = 0): string {
  const d = new Date(baseIso)
  d.setUTCDate(d.getUTCDate() + days)
  d.setUTCHours(d.getUTCHours() + hourBump)
  return d.toISOString()
}

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------

async function main() {
  console.log("→ ensuring 10 patients (auth.users + profiles)…")
  await ensurePatients()
  console.log("→ Telegram links…")
  await ensureTelegramLinks()
  console.log("→ clearing prior demo data…")
  await clearPriorDemoData()
  console.log("→ seeding narrative (appointments + dispatches + responses)…")
  await seedNarrative()
  console.log("\n✅ Demo seed complete.")
}

main().catch((err) => {
  console.error("\n✗ seed failed:", err)
  process.exit(1)
})
