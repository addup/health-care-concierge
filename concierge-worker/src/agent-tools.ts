/**
 * Agent tool definitions + dispatcher.
 *
 * The schemas follow OpenAI's `tools` format which Workers AI Llama 3.3
 * accepts. Each tool either returns data the LLM consumes, or has a
 * UI side effect (renders a Telegram message and ends the turn).
 */

import type { Env } from "./env"
import { patientClient, serviceClient } from "./supabase"

/**
 * Reference-data reads (specialties, appointment_types, doctors,
 * get_available_slots, check_slot_available) use the service role:
 *   - This is non-PHI catalog/availability data
 *   - The platform's RLS on these tables may not grant patient read access
 *   - Cleaner than chasing RLS for every tool call
 *
 * Patient-scoped writes (appointments INSERT/UPDATE) still go through
 * patientClient so RLS gates them by auth.uid(). Audit log writes use
 * service role too.
 */
import { sendMessage, type ReplyMarkup } from "./telegram"
import { putShortId } from "./short-id"
import { logAction } from "./audit"
import type { Locale } from "./i18n"

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface ToolCtx {
  env: Env
  storage: DurableObjectStorage
  chat_id: number
  locale: Locale
  auth: { patient_id: string; access_token: string }
}

export interface ToolResult {
  /** JSON-serialisable payload the LLM sees as the tool message content. */
  data: unknown
  /** True when this tool sent something to the user and we should pause the loop. */
  ends_turn?: boolean
  /** True when the conversation must terminate (e.g. red-flag escalation). */
  terminate?: boolean
}

// ---------------------------------------------------------------------
// Tool schemas (OpenAI shape)
// ---------------------------------------------------------------------

export const AGENT_TOOLS = [
  {
    name: "list_specialties",
    description: "Lista todas as especialidades médicas activas oferecidas pela clínica.",
    parameters: { type: "object", properties: {}, required: [] }
  },
  {
    name: "list_appointment_types",
    description: "Lista os tipos de consulta activos para uma especialidade (ex.: Primeira consulta, Consulta de seguimento).",
    parameters: {
      type: "object",
      properties: {
        specialty_id: { type: "string", description: "UUID da especialidade." }
      },
      required: ["specialty_id"]
    }
  },
  {
    name: "list_doctors",
    description: "Lista os médicos disponíveis para uma especialidade. Usa apenas se o paciente perguntar por um médico específico.",
    parameters: {
      type: "object",
      properties: {
        specialty_id: { type: "string", description: "UUID da especialidade." }
      },
      required: ["specialty_id"]
    }
  },
  {
    name: "find_dates_with_availability",
    description: "Procura nos próximos N dias as datas que têm pelo menos um slot disponível para o tipo de consulta. Devolve lista de datas YYYY-MM-DD. Lista vazia = sem disponibilidade no horizonte.",
    parameters: {
      type: "object",
      properties: {
        appointment_type_id: { type: "string" },
        lookahead_days: { type: "number", description: "Default 14, máximo 30." },
        doctor_id: { type: "string", description: "Opcional, filtra por médico." }
      },
      required: ["appointment_type_id"]
    }
  },
  {
    name: "list_available_slots",
    description: "Lista os horários (slots) disponíveis para um tipo de consulta numa data. Cada slot tem time HH:MM, doctor_id e doctor_name.",
    parameters: {
      type: "object",
      properties: {
        appointment_type_id: { type: "string" },
        target_date: { type: "string", description: "YYYY-MM-DD" },
        doctor_id: { type: "string", description: "Opcional, filtra por médico." }
      },
      required: ["appointment_type_id", "target_date"]
    }
  },
  {
    name: "suggest_specialty",
    description: "Sugere UMA especialidade ao paciente e pede confirmação. Botões: 'Sim, [Especialidade]' / 'Quero outra opção'. Usa quando o motivo do paciente sugere uma especialidade clara. Encerra o turno.",
    parameters: {
      type: "object",
      properties: {
        specialty_id: { type: "string", description: "UUID exacto da especialidade da lista no system prompt." },
        prompt_pt: { type: "string", description: "Mensagem opcional antes dos botões. Se vazia, usamos uma default." }
      },
      required: ["specialty_id"]
    }
  },
  {
    name: "show_specialty_list",
    description: "Mostra TODAS as especialidades activas ao paciente como botões. Usa quando o paciente pediu 'outra opção' depois de suggest_specialty, ou quando o motivo é genuinamente ambíguo. Encerra o turno.",
    parameters: {
      type: "object",
      properties: {
        prompt_pt: { type: "string", description: "Mensagem antes dos botões." }
      },
      required: ["prompt_pt"]
    }
  },
  {
    name: "show_appointment_types",
    description: "Mostra os tipos de consulta activos para uma especialidade como botões. Se houver só 1 tipo, segue automaticamente sem mostrar botões. Encerra o turno (ou retorna single_type_auto_selected se só houve 1).",
    parameters: {
      type: "object",
      properties: {
        specialty_id: { type: "string" },
        prompt_pt: { type: "string", description: "Mensagem opcional antes dos botões." }
      },
      required: ["specialty_id"]
    }
  },
  {
    name: "show_dates_with_availability",
    description: "Pesquisa disponibilidade nos próximos 14 dias e mostra ao paciente as datas disponíveis como botões. Se nenhuma data tiver slots, retorna no_dates (chama register_interest a seguir). Encerra o turno.",
    parameters: {
      type: "object",
      properties: {
        appointment_type_id: { type: "string" },
        doctor_id: { type: "string", description: "Opcional, filtra." },
        prompt_pt: { type: "string", description: "Mensagem opcional antes dos botões." }
      },
      required: ["appointment_type_id"]
    }
  },
  {
    name: "show_slots_for_date",
    description: "Mostra os horários disponíveis para um tipo de consulta numa data como botões. Encerra o turno.",
    parameters: {
      type: "object",
      properties: {
        appointment_type_id: { type: "string" },
        target_date: { type: "string", description: "YYYY-MM-DD" },
        doctor_id: { type: "string", description: "Opcional." },
        prompt_pt: { type: "string", description: "Mensagem opcional antes dos botões." }
      },
      required: ["appointment_type_id", "target_date"]
    }
  },
  {
    name: "confirm_booking",
    description: "Mostra ao paciente um resumo da consulta a marcar e dois botões: Confirmar / Cancelar. OBRIGATÓRIO antes de create_appointment. Encerra o turno.",
    parameters: {
      type: "object",
      properties: {
        summary_pt: {
          type: "string",
          description: "Resumo curto em PT-PT: especialidade, tipo, dia, hora, médico."
        }
      },
      required: ["summary_pt"]
    }
  },
  {
    name: "create_appointment",
    description: "Cria a consulta na base de dados. Retorna {success, appointment_id?, error?}. Verifica disponibilidade do slot antes de inserir.",
    parameters: {
      type: "object",
      properties: {
        doctor_id: { type: "string" },
        appointment_type_id: { type: "string" },
        scheduled_at: { type: "string", description: "ISO timestamp UTC, ex 2026-05-08T09:30:00Z" },
        duration_min: { type: "number" }
      },
      required: ["doctor_id", "appointment_type_id", "scheduled_at", "duration_min"]
    }
  },
  {
    name: "register_interest",
    description: "Regista o interesse do paciente quando não há disponibilidade no horizonte. A clínica vai contactá-lo. Diz ao paciente em mensagem natural que o interesse ficou registado.",
    parameters: {
      type: "object",
      properties: {
        specialty_id: { type: "string" },
        appointment_type_id: { type: "string", description: "Opcional." },
        note: { type: "string", description: "Contexto extra para a clínica (motivo, restrições, etc.)." }
      },
      required: ["specialty_id"]
    }
  },
  {
    name: "escalate_red_flag",
    description: "Bandeira vermelha — sintomas que precisam de avaliação urgente. Encaminha o paciente para 112. NÃO marques consulta. Encerra a conversa.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Sintoma que disparou a escalation." }
      },
      required: ["reason"]
    }
  }
] as const

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------

interface RawArgs {
  [k: string]: unknown
}

export async function dispatchTool(
  name: string,
  rawArgs: string,
  ctx: ToolCtx
): Promise<ToolResult> {
  let args: RawArgs
  try {
    args = JSON.parse(rawArgs || "{}") as RawArgs
  } catch {
    return { data: { error: "tool_args_not_json" } }
  }

  try {
    switch (name) {
      case "list_specialties": return await toolListSpecialties(ctx)
      case "list_appointment_types": return await toolListAppointmentTypes(ctx, args)
      case "list_doctors": return await toolListDoctors(ctx, args)
      case "find_dates_with_availability": return await toolFindDates(ctx, args)
      case "list_available_slots": return await toolListSlots(ctx, args)
      case "suggest_specialty": return await toolSuggestSpecialty(ctx, args)
      case "show_specialty_list": return await toolShowSpecialtyList(ctx, args)
      case "show_appointment_types": return await toolShowAppointmentTypes(ctx, args)
      case "show_dates_with_availability": return await toolShowDatesWithAvailability(ctx, args)
      case "show_slots_for_date": return await toolShowSlotsForDate(ctx, args)
      case "present_choices": return await toolPresentChoices(ctx, args)  // legacy
      case "confirm_booking": return await toolConfirmBooking(ctx, args)
      case "create_appointment": return await toolCreateAppointment(ctx, args)
      case "register_interest": return await toolRegisterInterest(ctx, args)
      case "escalate_red_flag": return await toolEscalateRedFlag(ctx, args)
      default: return { data: { error: `unknown_tool:${name}` } }
    }
  } catch (err) {
    console.error("[tool error]", name, err)
    return { data: { error: "tool_threw", message: String(err) } }
  }
}

// ---------------------------------------------------------------------
// Individual tool implementations
// ---------------------------------------------------------------------

async function toolListSpecialties(ctx: ToolCtx): Promise<ToolResult> {
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb
    .from("specialties")
    .select("id, name")
    .eq("is_active", true)
    .order("name")
  if (error) return { data: { error: error.message } }
  return { data: { specialties: data ?? [] } }
}

async function toolListAppointmentTypes(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const specialty_id = String(args.specialty_id ?? "")
  if (!specialty_id) return { data: { error: "specialty_id_required" } }
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb
    .from("appointment_types")
    .select("id, name, default_duration_min")
    .eq("specialty_id", specialty_id)
    .eq("is_active", true)
    .order("name")
  if (error) return { data: { error: error.message } }
  return { data: { types: data ?? [] } }
}

async function toolListDoctors(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const specialty_id = String(args.specialty_id ?? "")
  if (!specialty_id) return { data: { error: "specialty_id_required" } }
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb
    .from("doctor_specialties")
    .select("doctor_id, doctors!inner(id, is_active, profile:profiles!inner(chosen_name))")
    .eq("specialty_id", specialty_id)
  if (error) return { data: { error: error.message } }
  const doctors = (data ?? []).flatMap((row) => {
    const d = (row as unknown as {
      doctors?: { id: string; is_active: boolean; profile?: { chosen_name?: string } }
    }).doctors
    if (!d || !d.is_active) return []
    return [{ id: d.id, name: d.profile?.chosen_name ?? "" }]
  })
  return { data: { doctors } }
}

interface SlotBlob {
  time: string
  doctor_id: string
  doctor_name: string
}

function isSlotBlob(v: unknown): v is SlotBlob {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.time === "string" && typeof o.doctor_id === "string" && typeof o.doctor_name === "string"
}

async function toolFindDates(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const appointment_type_id = String(args.appointment_type_id ?? "")
  if (!appointment_type_id) return { data: { error: "appointment_type_id_required" } }
  const lookahead = Math.min(Number(args.lookahead_days ?? 14), 30)
  const doctor_id = args.doctor_id ? String(args.doctor_id) : undefined

  const sb = serviceClient(ctx.env)
  const today = new Date()
  const candidates: string[] = []
  for (let i = 0; i < lookahead; i++) {
    const d = new Date(today)
    d.setUTCDate(today.getUTCDate() + i)
    candidates.push(d.toISOString().slice(0, 10))
  }

  const checks = await Promise.all(
    candidates.map(async (iso) => {
      const { data, error } = await sb.rpc("get_available_slots", {
        _appointment_type_id: appointment_type_id,
        _target_date: iso,
        ...(doctor_id ? { _doctor_id_filter: doctor_id } : {})
      })
      if (error || !data) return { iso, hasSlots: false }
      const slots = (data as unknown[]).filter(isSlotBlob)
      return { iso, hasSlots: slots.length > 0 }
    })
  )
  const dates = checks.filter((c) => c.hasSlots).map((c) => c.iso)
  return { data: { dates } }
}

async function toolListSlots(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const appointment_type_id = String(args.appointment_type_id ?? "")
  const target_date = String(args.target_date ?? "")
  if (!appointment_type_id || !target_date) {
    return { data: { error: "missing_required_args" } }
  }
  const doctor_id = args.doctor_id ? String(args.doctor_id) : undefined
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb.rpc("get_available_slots", {
    _appointment_type_id: appointment_type_id,
    _target_date: target_date,
    ...(doctor_id ? { _doctor_id_filter: doctor_id } : {})
  })
  if (error) return { data: { error: error.message } }
  const slots = (data as unknown[]).filter(isSlotBlob)
  return { data: { slots } }
}

async function toolPresentChoices(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const prompt = String(args.prompt_pt ?? "")
  const kind = String(args.kind ?? "")
  const rawOptions = Array.isArray(args.options) ? args.options : []
  if (!prompt || !kind || rawOptions.length === 0) {
    return {
      data: {
        error: "invalid_present_choices_args",
        hint: "Required: prompt_pt (non-empty), kind (specialty|appointment_type|date|slot|doctor), options (non-empty array of {id, label}). Use REAL ids from the database, never invent.",
        got: { prompt_len: prompt.length, kind, options_len: rawOptions.length }
      }
    }
  }

  // Validate option ids against the database for the kinds that map to
  // real records. Otherwise the LLM can hallucinate specialty/type/doctor
  // names ("Alergologia", "Neurologia") that don't exist in the clinic.
  const validIds = await loadValidIds(ctx, kind)
  if (validIds !== null) {
    const filtered = rawOptions.filter((opt) => {
      const id = String((opt as { id?: unknown }).id ?? "")
      // Allow "other" as an escape-hatch for kind=specialty so the LLM
      // can offer "Quero outra opção" without inventing a specialty.
      if (kind === "specialty" && id === "other") return true
      return validIds.has(id)
    })
    if (filtered.length === 0) {
      return {
        data: {
          error: "no_valid_options",
          hint: `Para kind="${kind}", todos os ids têm de existir na base de dados. Nenhum dos ids fornecidos é válido. Não inventes ids — usa exactamente os UUIDs do system prompt (especialidades) ou os retornados por list_appointment_types / list_doctors.`,
          provided_ids: rawOptions.map((o) => String((o as { id?: unknown }).id ?? "")),
          valid_ids_sample: Array.from(validIds).slice(0, 10)
        }
      }
    }
    if (filtered.length < rawOptions.length) {
      console.log(JSON.stringify({
        tag: "agent-options-filtered",
        kind,
        provided: rawOptions.length,
        kept: filtered.length,
        dropped_ids: rawOptions
          .filter((o) => !validIds.has(String((o as { id?: unknown }).id ?? "")) &&
                        !(kind === "specialty" && String((o as { id?: unknown }).id ?? "") === "other"))
          .map((o) => String((o as { id?: unknown }).id ?? ""))
      }))
    }
    rawOptions.length = 0
    rawOptions.push(...filtered)
  }

  if (rawOptions.length > 12) rawOptions.length = 12  // Telegram practical limit

  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const opt of rawOptions) {
    const o = opt as { id?: unknown; label?: unknown }
    const id = String(o.id ?? "")
    const label = String(o.label ?? "")
    if (!id || !label) continue
    const short = await putShortId(ctx.env, { kind, id, label })
    inline_keyboard.push([{ text: label.slice(0, 60), callback_data: `ag:${short}` }])
  }
  await sendMessage(ctx.env, ctx.chat_id, prompt, { inline_keyboard })
  return { data: { rendered: true, kind, count: rawOptions.length }, ends_turn: true }
}

/**
 * Returns a set of valid ids for the given choice kind, or null if the
 * kind doesn't map to a fixed DB enumeration (date / slot — those flow
 * directly from earlier tool calls).
 */
async function loadValidIds(ctx: ToolCtx, kind: string): Promise<Set<string> | null> {
  const sb = serviceClient(ctx.env)
  if (kind === "specialty") {
    const { data } = await sb.from("specialties").select("id").eq("is_active", true)
    return new Set((data ?? []).map((r) => r.id))
  }
  if (kind === "appointment_type") {
    const { data } = await sb.from("appointment_types").select("id").eq("is_active", true)
    return new Set((data ?? []).map((r) => r.id))
  }
  if (kind === "doctor") {
    const { data } = await sb.from("doctors").select("id").eq("is_active", true)
    return new Set((data ?? []).map((r) => r.id))
  }
  return null  // date, slot — caller-provided strings, no fixed enum
}

async function toolConfirmBooking(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const summary = String(args.summary_pt ?? "")
  if (!summary) return { data: { error: "summary_required" } }
  const yesShort = await putShortId(ctx.env, { kind: "confirm", id: "yes", label: "Confirmar" })
  const noShort = await putShortId(ctx.env, { kind: "confirm", id: "no", label: "Cancelar" })
  await sendMessage(ctx.env, ctx.chat_id, summary, {
    inline_keyboard: [
      [{ text: "✅ Confirmar", callback_data: `ag:${yesShort}` }],
      [{ text: "✗ Cancelar", callback_data: `ag:${noShort}` }]
    ]
  })
  return { data: { rendered: true }, ends_turn: true }
}

async function toolCreateAppointment(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const doctor_id = String(args.doctor_id ?? "")
  const appointment_type_id = String(args.appointment_type_id ?? "")
  const scheduled_at = String(args.scheduled_at ?? "")
  const duration_min = Number(args.duration_min ?? 0)
  if (!doctor_id || !appointment_type_id || !scheduled_at || !duration_min) {
    return { data: { success: false, error: "missing_required_args" } }
  }

  const sb = patientClient(ctx.env, ctx.auth.access_token)

  const { data: ok } = await sb.rpc("check_slot_available", {
    _doctor_id: doctor_id,
    _scheduled_at: scheduled_at,
    _duration_min: duration_min
  })
  if (ok === false) {
    return { data: { success: false, error: "slot_taken" } }
  }

  const { data: inserted, error } = await sb
    .from("appointments")
    .insert({
      patient_id: ctx.auth.patient_id,
      doctor_id,
      appointment_type_id,
      scheduled_at,
      duration_min,
      status: "scheduled"
    })
    .select("id")
    .single()

  if (error || !inserted) {
    await logAction(ctx.env, {
      patient_id: ctx.auth.patient_id,
      telegram_user_id: ctx.chat_id,
      intent: "BOOK",
      action: "agent_book_failed",
      payload: { error: error?.message ?? "unknown" }
    })
    return { data: { success: false, error: error?.message ?? "insert_failed" } }
  }

  await logAction(ctx.env, {
    patient_id: ctx.auth.patient_id,
    telegram_user_id: ctx.chat_id,
    intent: "BOOK",
    action: "agent_book_succeeded",
    payload: { appointment_id: inserted.id, doctor_id, appointment_type_id, scheduled_at }
  })
  return { data: { success: true, appointment_id: inserted.id } }
}

async function toolRegisterInterest(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const specialty_id = String(args.specialty_id ?? "")
  if (!specialty_id) return { data: { ok: false, error: "specialty_id_required" } }
  const appointment_type_id = args.appointment_type_id ? String(args.appointment_type_id) : null
  const note = args.note ? String(args.note) : null
  await logAction(ctx.env, {
    patient_id: ctx.auth.patient_id,
    telegram_user_id: ctx.chat_id,
    intent: "BOOK",
    action: "agent_specialty_interest_registered",
    payload: { specialty_id, appointment_type_id, note }
  })
  return { data: { ok: true } }
}

// ---------------------------------------------------------------------
// New narrower "show X" tools — the LLM only passes semantic ids; the
// bot does the rendering (DB queries, button construction, KV stash).
// Replaces the more error-prone present_choices tool.
// ---------------------------------------------------------------------

async function toolSuggestSpecialty(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const specialty_id = String(args.specialty_id ?? "")
  if (!specialty_id) return { data: { error: "specialty_id_required" } }

  const sb = serviceClient(ctx.env)
  const { data: spec } = await sb
    .from("specialties")
    .select("id, name")
    .eq("id", specialty_id)
    .eq("is_active", true)
    .maybeSingle()
  if (!spec) {
    return {
      data: {
        error: "specialty_not_found_or_inactive",
        hint: "Use exactamente um dos UUIDs listados no system prompt em ESPECIALIDADES DISPONÍVEIS. Não inventes."
      }
    }
  }

  const prompt = String(args.prompt_pt ?? "") || `Sugiro ${spec.name}. Concordas?`
  const yesShort = await putShortId(ctx.env, {
    kind: "specialty", id: spec.id, label: spec.name,
    meta: { specialty_name: spec.name }
  })
  const otherShort = await putShortId(ctx.env, {
    kind: "specialty_other", id: "other", label: "Quero outra opção"
  })
  await sendMessage(ctx.env, ctx.chat_id, prompt, {
    inline_keyboard: [
      [{ text: `Sim, ${spec.name}`.slice(0, 60), callback_data: `ag:${yesShort}` }],
      [{ text: "Quero outra opção", callback_data: `ag:${otherShort}` }]
    ]
  })
  return {
    data: { rendered: true, suggested_id: spec.id, suggested_name: spec.name },
    ends_turn: true
  }
}

async function toolShowSpecialtyList(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb
    .from("specialties")
    .select("id, name")
    .eq("is_active", true)
    .order("name")
  console.log(JSON.stringify({
    tag: "tool-show-specialty-list",
    count: data?.length ?? 0,
    error: error?.message ?? null
  }))
  if (error || !data || data.length === 0) {
    return {
      data: {
        error: "no_active_specialties",
        message: error?.message ?? "table returned 0 rows"
      },
      ends_turn: true  // Don't loop on this — bail.
    }
  }
  const prompt = String(args.prompt_pt ?? "") || "Que especialidade procuras?"
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const s of data) {
    const short = await putShortId(ctx.env, {
      kind: "specialty", id: s.id, label: s.name, meta: { specialty_name: s.name }
    })
    inline_keyboard.push([{ text: s.name.slice(0, 60), callback_data: `ag:${short}` }])
  }
  await sendMessage(ctx.env, ctx.chat_id, prompt, { inline_keyboard })
  return { data: { rendered: true, count: data.length }, ends_turn: true }
}

async function toolShowAppointmentTypes(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const specialty_id = String(args.specialty_id ?? "")
  if (!specialty_id) return { data: { error: "specialty_id_required" } }
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb
    .from("appointment_types")
    .select("id, name, default_duration_min")
    .eq("specialty_id", specialty_id)
    .eq("is_active", true)
    .order("name")
  console.log(JSON.stringify({
    tag: "tool-show-appointment-types",
    specialty_id,
    count: data?.length ?? 0,
    error: error?.message ?? null
  }))
  if (error || !data || data.length === 0) {
    return {
      data: { error: "no_active_types_for_specialty", message: error?.message ?? null },
      ends_turn: true
    }
  }

  if (data.length === 1) {
    const only = data[0]!
    return {
      data: {
        single_type_auto_selected: true,
        appointment_type_id: only.id,
        appointment_type_name: only.name,
        default_duration_min: only.default_duration_min
      }
    }
  }

  const prompt = String(args.prompt_pt ?? "") || "Que tipo de consulta?"
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const t of data) {
    const short = await putShortId(ctx.env, {
      kind: "appointment_type",
      id: t.id,
      label: t.name,
      meta: { appointment_type_name: t.name, default_duration_min: t.default_duration_min }
    })
    inline_keyboard.push([{ text: t.name.slice(0, 60), callback_data: `ag:${short}` }])
  }
  await sendMessage(ctx.env, ctx.chat_id, prompt, { inline_keyboard })
  return { data: { rendered: true, count: data.length }, ends_turn: true }
}

async function toolShowDatesWithAvailability(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const appointment_type_id = String(args.appointment_type_id ?? "")
  if (!appointment_type_id) return { data: { error: "appointment_type_id_required" } }
  const doctor_id = args.doctor_id ? String(args.doctor_id) : undefined
  const sb = serviceClient(ctx.env)
  const today = new Date()
  const candidates: string[] = []
  for (let i = 0; i < 14; i++) {
    const d = new Date(today)
    d.setUTCDate(today.getUTCDate() + i)
    candidates.push(d.toISOString().slice(0, 10))
  }
  const checks = await Promise.all(
    candidates.map(async (iso) => {
      const { data, error } = await sb.rpc("get_available_slots", {
        _appointment_type_id: appointment_type_id,
        _target_date: iso,
        ...(doctor_id ? { _doctor_id_filter: doctor_id } : {})
      })
      if (error || !data) return { iso, hasSlots: false }
      const slots = (data as unknown[]).filter(isSlotBlob)
      return { iso, hasSlots: slots.length > 0 }
    })
  )
  const dates = checks.filter((c) => c.hasSlots).map((c) => c.iso).slice(0, 6)
  if (dates.length === 0) {
    return { data: { no_dates: true, lookahead_days: 14 } }
  }
  const prompt = String(args.prompt_pt ?? "") || "Que dia preferes?"
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const iso of dates) {
    const label = formatDateLabel(iso)
    const short = await putShortId(ctx.env, {
      kind: "date", id: iso, label, meta: { target_date: iso }
    })
    inline_keyboard.push([{ text: label, callback_data: `ag:${short}` }])
  }
  await sendMessage(ctx.env, ctx.chat_id, prompt, { inline_keyboard })
  return { data: { rendered: true, count: dates.length }, ends_turn: true }
}

async function toolShowSlotsForDate(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const appointment_type_id = String(args.appointment_type_id ?? "")
  const target_date = String(args.target_date ?? "")
  if (!appointment_type_id || !target_date) {
    return { data: { error: "missing_required_args" } }
  }
  const doctor_id = args.doctor_id ? String(args.doctor_id) : undefined
  const sb = serviceClient(ctx.env)
  const { data, error } = await sb.rpc("get_available_slots", {
    _appointment_type_id: appointment_type_id,
    _target_date: target_date,
    ...(doctor_id ? { _doctor_id_filter: doctor_id } : {})
  })
  if (error || !data) return { data: { error: "lookup_failed", message: error?.message } }
  const slots = (data as unknown[]).filter(isSlotBlob).slice(0, 8)
  if (slots.length === 0) return { data: { no_slots: true } }

  const prompt = String(args.prompt_pt ?? "") || "Que horário preferes?"
  const inline_keyboard: ReplyMarkup["inline_keyboard"] = []
  for (const slot of slots) {
    const scheduled_at = `${target_date}T${slot.time}:00Z`
    const short = await putShortId(ctx.env, {
      kind: "slot",
      id: scheduled_at,
      label: `${slot.time} · ${slot.doctor_name}`,
      meta: {
        doctor_id: slot.doctor_id,
        doctor_name: slot.doctor_name,
        scheduled_at,
        time: slot.time,
        appointment_type_id
      }
    })
    inline_keyboard.push([{ text: `${slot.time} · ${slot.doctor_name}`.slice(0, 60), callback_data: `ag:${short}` }])
  }
  await sendMessage(ctx.env, ctx.chat_id, prompt, { inline_keyboard })
  return { data: { rendered: true, count: slots.length }, ends_turn: true }
}

function formatDateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const diff = Math.round((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  if (diff === 0) return "Hoje"
  if (diff === 1) return "Amanhã"
  const dows = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
  return `${dows[d.getUTCDay()]} ${d.getUTCDate()}`
}

async function toolEscalateRedFlag(ctx: ToolCtx, args: RawArgs): Promise<ToolResult> {
  const reason = String(args.reason ?? "")
  await sendMessage(
    ctx.env,
    ctx.chat_id,
    "⚠️ Os teus sintomas precisam de avaliação urgente. Liga 112 ou dirige-te ao serviço de urgência mais próximo. A clínica não substitui cuidados de urgência."
  )
  await logAction(ctx.env, {
    patient_id: ctx.auth.patient_id,
    telegram_user_id: ctx.chat_id,
    intent: "TRIAGE",
    action: "agent_red_flag_llm",
    payload: { reason }
  })
  // service-side mark + scrub state
  return { data: { rendered: true }, ends_turn: true, terminate: true }
}

// Re-exported for the agent loop.
export { isSlotBlob }
