/**
 * Conversational booking agent.
 *
 * LLM-driven slot-filling with tool calling. Replaces the deterministic
 * triage→booking handoff for the free-text entry path. The deterministic
 * 5-step booking flow (booking.ts) stays in place for the menu button.
 */

import type { Env } from "./env"
import { sendMessage, sendChatAction } from "./telegram"
import { t, type Locale } from "./i18n"
import { logAction } from "./audit"
import { getShortId } from "./short-id"
import {
  AGENT_TOOLS,
  dispatchTool,
  type ToolCtx,
  type ToolResult
} from "./agent-tools"
import { patientClient } from "./supabase"

// ---------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------

type Role = "system" | "user" | "assistant" | "tool"

interface ToolCall {
  id: string
  name: string
  arguments: string  // JSON string
}

interface AgentMessage {
  role: Role
  content: string | null
  tool_calls?: ToolCall[]
  // Tool messages tag the call by name (Cloudflare Llama style).
  name?: string
}

export interface AgentState {
  messages: AgentMessage[]
  failure_count: number  // consecutive LLM failures
}

const STORAGE_KEY = "agent_state"
const PRIMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct"
const LLM_TIMEOUT_MS = 8000          // generous; tool-calling responses can be slower
const MAX_LOOP_ITERATIONS = 6        // tool-call rounds per user turn
const MAX_MESSAGES = 40              // truncate older history beyond this (keeping system)
const MAX_CONSECUTIVE_FAILURES = 3   // before suggesting the deterministic flow

interface AuthCtx {
  patient_id: string
  access_token: string
}

// ---------------------------------------------------------------------
// Red-flag pre-LLM safety net
// ---------------------------------------------------------------------

const RED_FLAG_REGEX = new RegExp(
  [
    "dor\\s+(forte|intensa|aguda)?\\s*no\\s+peito",
    "aperto\\s+no\\s+peito",
    "chest\\s+pain",
    "irradi(a|ar|ando)\\s+para\\s+o\\s+bra[çc]o",
    "radiating\\s+to\\s+(my\\s+)?arm",
    "falta\\s+de\\s+ar\\s+s[úu]bita",
    "dispneia\\s+s[úu]bita",
    "sudden\\s+shortness\\s+of\\s+breath",
    "anafil(axia|axis)",
    "anaphylaxis",
    "incho\\s+(na|nos)\\s+(cara|l[áa]bios|garganta)",
    "swelling\\s+of\\s+(face|lips|throat|tongue)",
    "perda\\s+de\\s+for[çc]a\\s+(de\\s+um\\s+lado|num\\s+lado)",
    "weakness\\s+on\\s+one\\s+side",
    "fala\\s+arrastada",
    "slurred\\s+speech",
    "perda\\s+de\\s+vis[ãa]o\\s+s[úu]bita",
    "sudden\\s+vision\\s+loss",
    "(pior|worst)\\s+dor\\s+de\\s+cabe[çc]a\\s+(da\\s+minha\\s+vida|de\\s+sempre)",
    "thunderclap\\s+headache",
    "worst\\s+headache\\s+of\\s+my\\s+life",
    "abd[óo]men\\s+r[íi]gido",
    "rigid\\s+abdomen",
    "hemorragia\\s+(grave|abundante)",
    "heavy\\s+bleeding",
    "(ideias?\\s+suicidas?|ideacao\\s+suicida|vou\\s+matar-me|n[ãa]o\\s+quero\\s+viver)",
    "(suicidal|kill\\s+myself|want\\s+to\\s+die|self[\\s-]?harm)",
    "gr[áa]vida.{0,20}(sangr|hemorragi)",
    "pregnant.{0,20}bleeding",
    "beb[éê]\\s+letar"
  ].join("|"),
  "i"
)

export function detectRedFlag(text: string): boolean {
  return RED_FLAG_REGEX.test(text)
}

// ---------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------

const SYSTEM_PROMPT_PT = `LÍNGUA OBRIGATÓRIA: PORTUGUÊS DE PORTUGAL.
Tudo o que escreves ao paciente é em PT-PT, sem excepções. Mesmo se o paciente trocar para inglês, respondes em PT-PT.

És o concierge da clínica EQUAL Care, em Portugal. Recepcionista virtual: marcas consultas. Tom calmo, frases curtas.

REGRAS ABSOLUTAS
1. **Língua: SEMPRE português de Portugal.** Nunca inglês, nunca português do Brasil. Mesmo se o paciente escrever em inglês, respondes em PT-PT.
2. **Nunca narres o teu plano ao paciente.** Não digas "vou consultar…", "preciso de chamar…", "agora vou…", "first I need to…". O paciente vê apenas o resultado. Tools são silenciosas.
3. **Nunca menciones nomes de tools, ids, "specialty_id" ou outros termos técnicos.** O paciente nunca lê isso.
4. **Não diagnostiques. Não sugiras tratamentos.**
5. **Não inventes nada** — médicos, tipos, horários, datas vêm SEMPRE de tool calls.

INFERÊNCIA DE ESPECIALIDADE
Quando o paciente descreve um motivo, decides tu a especialidade com o teu próprio raciocínio clínico:
- sintomas gerais, gripe, dores, infecções → Medicina Geral / Familiar
- ansiedade, depressão, sono, stress → Psicologia
- alimentação, peso, diabetes, dieta → Nutrição
- gravidez, saúde reprodutiva → Ginecologia (se na lista)
Confirmas com botões antes de avançar.

BANDEIRAS VERMELHAS — escalate_red_flag IMEDIATAMENTE (sem booking):
dor torácica intensa ou irradiando, dispneia súbita, défice neurológico súbito, abdómen rígido, ideação suicida, hemorragia grave, anafilaxia, grávida com sangramento, bebé letárgico.

FLUXO INTERNO (para ti, NUNCA explícito ao paciente)
1. Vês o motivo. Se red-flag → escalate_red_flag.
2. Decides especialidade. Confirmas com present_choices(kind="specialty") com 2 opções: a tua sugestão (id real) e {id:"other", label:"Quero outra opção"}.
3. Se "other" → present_choices(kind="specialty") com a lista completa (ids reais já tens no system).
4. list_appointment_types → 1 tipo: segues; >1 tipo: present_choices(kind="appointment_type").
5. find_dates_with_availability(appointment_type_id, lookahead_days=14).
6. Sem datas → register_interest + mensagem "Não há disponibilidade nos próximos 14 dias. Vou registar e a clínica vai contactar-te em breve."
7. Com datas → present_choices(kind="date") com até 6 opções, label "Hoje" / "Amanhã" / "Qua 14".
8. list_available_slots → present_choices(kind="slot"), label "HH:MM · Dr. Nome".
9. confirm_booking(summary_pt="Medicina Geral, Primeira consulta, Qua 14 às 09:30 com Dr. Silva. Confirmas?")
10. Confirmação positiva → create_appointment → mensagem "✅ Marcado: [resumo]. Vou enviar lembrete 24h antes."
11. Confirmação negativa → "Sem problema, recomeçamos. Diz-me como queres ajustar."

EXEMPLOS

❌ MAU (narras o plano):
   "Vou consultar os tipos de consulta agora."
   "I need to call list_appointment_types."
   "Preciso de saber a especialidade primeiro."
✅ BOM (apenas resultado):
   [chama list_appointment_types, depois present_choices]
   → "Que tipo prefere?" + botões

❌ MAU (texto + pergunta):
   "Sugiro Medicina Geral. Concordas?"
✅ BOM (botões):
   [chama present_choices(kind="specialty", options=[{id:"<uuid>", label:"Medicina Geral"}, {id:"other", label:"Quero outra opção"}], prompt_pt:"Sugiro Medicina Geral. Concordas?")]

PRINCÍPIOS DE UX
- Para qualquer escolha do paciente → present_choices, nunca pedir para escrever.
- create_appointment SÓ após confirm_booking + paciente carregar "Confirmar".
- Não repitas a mesma tool com os mesmos args.
- Mensagens ao paciente: 1-2 frases, sem markdown, sem mencionar processos internos.

LEMBRETE FINAL: Toda a tua saída visível ao paciente é em PT-PT.`

const SYSTEM_PROMPT_EN = `MANDATORY LANGUAGE: ENGLISH.
Everything you write to the patient is in English, no exceptions. Even if the patient writes in Portuguese, reply in English.

You are the concierge for EQUAL Care clinic in Portugal. Virtual receptionist: book appointments. Calm tone, short sentences.

ABSOLUTE RULES
1. **Language: ALWAYS English.** Never Portuguese, never any other language.
2. **Never narrate your plan to the patient.** Don't say "let me check…", "I need to call…", "now I'll…". The patient sees only the result. Tools are silent.
3. **Never mention tool names, ids, "specialty_id", or technical terms.** The patient never reads that.
4. **Don't diagnose. Don't suggest treatments.**
5. **Don't invent anything** — doctors, types, slots, dates always come from tool calls.

SPECIALTY INFERENCE
When the patient describes their reason, you decide the specialty using clinical reasoning:
- general symptoms, flu, pain, infections → General Medicine / Family
- anxiety, depression, sleep, stress → Psychology
- nutrition, weight, diabetes, diet → Nutrition
- pregnancy, reproductive health → Gynecology (if listed)
Confirm with buttons before proceeding.

RED FLAGS — escalate_red_flag IMMEDIATELY (no booking):
severe or radiating chest pain, sudden dyspnea, sudden focal neuro deficit, rigid abdomen, suicidal ideation, severe bleeding, anaphylaxis, pregnancy bleeding, lethargic infant.

INTERNAL FLOW (for you, NEVER spoken to the patient)
1. See the reason. Red-flag → escalate_red_flag.
2. Decide specialty. Confirm with present_choices(kind="specialty") with 2 options: your suggestion (real id) and {id:"other", label:"I want a different option"}.
3. If "other" → present_choices(kind="specialty") with the full list.
4. list_appointment_types → 1 type: continue; >1: present_choices(kind="appointment_type").
5. find_dates_with_availability(appointment_type_id, lookahead_days=14).
6. No dates → register_interest + message "No availability in the next 14 days. The clinic will reach out soon."
7. With dates → present_choices(kind="date") up to 6, label "Today" / "Tomorrow" / "Wed 14".
8. list_available_slots → present_choices(kind="slot"), label "HH:MM · Dr. Name".
9. confirm_booking(summary).
10. Confirmed → create_appointment → message "✅ Booked: [summary]. Reminder 24h before."

UX PRINCIPLES
- For any patient choice → present_choices, never ask them to type.
- create_appointment ONLY after confirm_booking + patient taps "Confirm".
- Don't repeat the same tool with the same args.
- Messages to the patient: 1-2 sentences, no markdown, no mention of internal processes.

FINAL REMINDER: All your patient-visible output is in English.`

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------

/**
 * Free-text entry — called from patient-agent.ts when:
 *   - intent classifier picks BOOK or TRIAGE on a free-text message, or
 *   - agent_state already exists (mid-flow).
 */
export async function handleAgentText(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  text: string
): Promise<void> {
  // Pre-LLM red-flag guard (belt and braces with the in-prompt instruction).
  if (detectRedFlag(text)) {
    await sendMessage(env, chat_id, t(locale, "triage_red_flag"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "TRIAGE",
      action: "agent_red_flag_pre_llm",
      payload: { text }
    })
    await storage.delete(STORAGE_KEY)
    return
  }

  const state = (await storage.get<AgentState>(STORAGE_KEY)) ?? newAgentState()
  const isFirstTurn = state.messages.length === 0
  const willHardcode = isFirstTurn && looksLikeGenericBookingEntry(text)

  console.log(JSON.stringify({
    tag: "agent-text",
    isFirstTurn,
    text_len: text.length,
    willHardcode,
    history_len: state.messages.length
  }))

  state.messages.push({ role: "user", content: text })

  // Deterministic first-turn open question — only when the message is a
  // plain booking entry ("marcar consulta", "olá quero marcar"). For
  // anything more substantive (a stated motive, a specialty hint), pass
  // straight to the LLM so we don't ask the obvious "qual o motivo?"
  // back to a patient who already gave one.
  if (willHardcode) {
    const open = locale === "en"
      ? "What brings you to seek care? Tell me in a few words."
      : "Qual o motivo para procurares cuidados de saúde? Conta-me em poucas palavras."
    state.messages.push({ role: "assistant", content: open })
    await sendMessage(env, chat_id, open)
    await persist(storage, state)
    return
  }

  await runLoop(env, storage, chat_id, locale, auth, state)
}

/**
 * Is this message a bare booking entry / greeting that should be met
 * with the open motive question? Returns false for messages that
 * already convey a motive ("Viagem para Angola", "tenho dores").
 */
function looksLikeGenericBookingEntry(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.length === 0) return false
  if (t.length > 45) return false
  // Pure greetings.
  if (/^(olá|ola|oi|bom\s+dia|boa\s+tarde|boa\s+noite|hi|hello|hey)\s*[!.?]?$/i.test(t)) return true
  // Booking-intent verbs without further detail. Allow optional
  // "consulta" / "uma consulta" suffix.
  return /^(quero\s+|preciso\s+(de\s+)?|gostava\s+(de\s+)?|posso\s+|book\s+|schedule\s+)?(marcar|agendar)(\s+(uma\s+)?consulta)?\s*[!.?]?$/i.test(t)
}

/**
 * Callback entry — called from patient-agent.ts when an `ag:<short>`
 * callback arrives. Decodes the short ID, injects synthetic context +
 * user reply, re-enters the loop.
 */
export async function handleAgentCallback(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  short: string
): Promise<void> {
  const decoded = await getShortId<{ kind: string; id: string; label: string }>(env, short)
  if (!decoded) {
    await sendMessage(env, chat_id, t(locale, "agent_choice_expired"))
    return
  }

  const state = (await storage.get<AgentState>(STORAGE_KEY)) ?? newAgentState()
  // System note tells the LLM the resolved id; user line carries the human label.
  state.messages.push({
    role: "system",
    content: `[user selected ${decoded.kind}: "${decoded.label}" with id="${decoded.id}"]`
  })
  state.messages.push({ role: "user", content: decoded.label })
  await runLoop(env, storage, chat_id, locale, auth, state)
}

// ---------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------

async function runLoop(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  state: AgentState
): Promise<void> {
  const ctx: ToolCtx = { env, storage, chat_id, locale, auth }
  // Detect repeated identical tool calls — the model occasionally gets
  // stuck calling the same tool with the same args after a validation
  // error. Two strikes and we bail with a friendly message.
  let lastSig = ""
  let repeatCount = 0

  // Pre-fetch the active specialties so we can inline their UUIDs in the
  // system prompt. Llama 3.3 fp8-fast tends to skip list_specialties and
  // invent ids; embedding the truth in the prompt sidesteps that.
  const specialtiesLine = await loadSpecialtiesLine(env, auth)

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    await sendChatAction(env, chat_id, "typing")
    const response = await callLlm(env, withSystem(state.messages, specialtiesLine, locale))

    if (!response) {
      state.failure_count += 1
      await persist(storage, state)
      if (state.failure_count >= MAX_CONSECUTIVE_FAILURES) {
        await storage.delete(STORAGE_KEY)
        await sendMessage(env, chat_id, t(locale, "agent_fallback_to_deterministic"))
      } else {
        await sendMessage(env, chat_id, t(locale, "agent_llm_failed"))
      }
      return
    }
    state.failure_count = 0

    console.log(JSON.stringify({
      tag: "agent-llm-response",
      iter: i,
      tool_calls: (response.tool_calls ?? []).map((tc) => ({
        name: tc.name,
        args: tc.arguments.length > 240 ? tc.arguments.slice(0, 240) + "…" : tc.arguments
      })),
      content_len: response.content?.length ?? 0
    }))

    if (response.tool_calls && response.tool_calls.length > 0) {
      // Repetition guard.
      const sig = response.tool_calls.map((tc) => `${tc.name}:${tc.arguments}`).join("|")
      if (sig === lastSig) {
        repeatCount += 1
        if (repeatCount >= 2) {
          console.log(JSON.stringify({ tag: "agent-loop-stuck", sig: sig.slice(0, 120) }))
          await sendMessage(env, chat_id, t(locale, "agent_iter_cap"))
          await storage.delete(STORAGE_KEY)
          return
        }
      } else {
        lastSig = sig
        repeatCount = 0
      }

      // Append assistant message with tool calls (content can be empty).
      state.messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls
      })

      let endTurn = false
      let terminate = false
      for (const tc of response.tool_calls) {
        const result: ToolResult = await dispatchTool(tc.name, tc.arguments, ctx)
        state.messages.push({
          role: "tool",
          name: tc.name,
          content: JSON.stringify(result.data)
        })
        if (result.ends_turn) endTurn = true
        if (result.terminate) terminate = true
      }

      if (terminate) {
        await storage.delete(STORAGE_KEY)
        return
      }
      if (endTurn) {
        await persist(storage, state)
        return
      }
      // No side-effect tools — keep looping so the LLM can react to results.
      continue
    }

    if (response.content) {
      state.messages.push({ role: "assistant", content: response.content })
      await sendMessage(env, chat_id, response.content)
      await persist(storage, state)
      return
    }

    // Empty response. Treat as a soft failure.
    state.failure_count += 1
    await persist(storage, state)
    await sendMessage(env, chat_id, t(locale, "agent_llm_failed"))
    return
  }

  // Iteration cap hit — likely the LLM is looping. Reset state.
  await sendMessage(env, chat_id, t(locale, "agent_iter_cap"))
  await storage.delete(STORAGE_KEY)
}

// ---------------------------------------------------------------------
// LLM wrapper
// ---------------------------------------------------------------------

interface LlmResponse {
  content: string | null
  tool_calls?: ToolCall[]
}

async function callLlm(env: Env, messages: AgentMessage[]): Promise<LlmResponse | null> {
  // Workers AI's chat schema rejects `content: null`. Coerce to "".
  // Strip empty fields so we don't trip oneOf branches.
  const sanitized = messages.map((m) => {
    const out: Record<string, unknown> = {
      role: m.role,
      content: typeof m.content === "string" ? m.content : ""
    }
    if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls
    if (m.name) out.name = m.name
    return out
  })

  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const out = await withTimeout(
        env.AI.run(model as never, {
          messages: sanitized,
          tools: AGENT_TOOLS,
          temperature: 0.2,
          max_tokens: 700
        } as never) as Promise<unknown>,
        LLM_TIMEOUT_MS
      )
      const parsed = parseLlmResponse(out)
      if (parsed) return parsed
      // Parse failed — log raw shape so we can debug.
      console.log(JSON.stringify({
        tag: "agent-llm-parse-failed",
        model,
        raw_shape: typeof out === "object" && out !== null ? Object.keys(out as object) : typeof out,
        raw_preview: JSON.stringify(out).slice(0, 500)
      }))
    } catch (err) {
      console.error("[agent llm error]", model, err)
    }
  }
  return null
}

function parseLlmResponse(raw: unknown): LlmResponse | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>

  // Cloudflare Workers AI tool-calling shape (Llama 3.x):
  //   { response?: string, tool_calls?: [{ name, arguments }] }
  // Where `arguments` is either a JSON string or already an object.
  // We also accept the OpenAI-nested fallback for safety.
  const content = typeof r.response === "string" ? r.response : null
  const tcRaw = (r.tool_calls ?? r.tool_call ?? null) as unknown
  if (Array.isArray(tcRaw)) {
    const tool_calls: ToolCall[] = tcRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null
        const e = entry as Record<string, unknown>
        // Accept both flat `{name, arguments}` and nested `{function: {name, arguments}}`.
        const flat = (typeof e.name === "string") ? e : (e.function as Record<string, unknown> | undefined)
        if (!flat) return null
        const name = typeof flat.name === "string" ? flat.name : null
        if (!name) return null
        const argsRaw = flat.arguments
        let argsStr: string
        if (typeof argsRaw === "string") argsStr = argsRaw
        else if (argsRaw && typeof argsRaw === "object") argsStr = JSON.stringify(argsRaw)
        else argsStr = "{}"
        const id = typeof e.id === "string" ? e.id : `tc_${Math.random().toString(36).slice(2, 10)}`
        return { id, name, arguments: argsStr }
      })
      .filter((x): x is ToolCall => x !== null)
    if (tool_calls.length > 0) return { content, tool_calls }
  }

  if (content !== null) return { content }
  return null
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function newAgentState(): AgentState {
  return {
    messages: [],
    failure_count: 0
  }
}

/** Prepend the system prompt and trim history to MAX_MESSAGES. */
function withSystem(
  messages: AgentMessage[],
  specialtiesLine: string,
  locale: Locale
): AgentMessage[] {
  const trimmed = messages.length > MAX_MESSAGES
    ? messages.slice(messages.length - MAX_MESSAGES)
    : messages
  const base = locale === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_PT
  const sys = specialtiesLine ? `${base}\n\n${specialtiesLine}` : base
  return [{ role: "system", content: sys }, ...trimmed]
}

/**
 * Build a system-prompt addendum listing active specialties with their
 * UUIDs. Lets the model use real ids directly in present_choices without
 * needing a prior list_specialties tool call.
 */
async function loadSpecialtiesLine(env: Env, auth: AuthCtx): Promise<string> {
  try {
    const sb = patientClient(env, auth.access_token)
    const { data, error } = await sb
      .from("specialties")
      .select("id, name")
      .eq("is_active", true)
      .order("name")
    if (error || !data || data.length === 0) return ""
    const lines = data.map((s) => `  - ${s.name} (id: ${s.id})`).join("\n")
    return `ESPECIALIDADES DISPONÍVEIS — usa SEMPRE estes ids exactos em present_choices, NUNCA inventes:\n${lines}`
  } catch {
    return ""
  }
}

async function persist(storage: DurableObjectStorage, state: AgentState): Promise<void> {
  // Trim before persist so storage doesn't bloat.
  if (state.messages.length > MAX_MESSAGES) {
    state.messages = state.messages.slice(state.messages.length - MAX_MESSAGES)
  }
  await storage.put(STORAGE_KEY, state)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}
