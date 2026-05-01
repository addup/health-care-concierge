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

// ---------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------

type Role = "system" | "user" | "assistant" | "tool"

interface AgentMessage {
  role: Role
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
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

const SYSTEM_PROMPT_PT = `És o concierge da clínica EQUAL Care, em Portugal. Conversas em PT-PT, tom calmo, frases curtas.

OBJECTIVO
Ajudar o paciente a marcar uma consulta. Se descrever sintomas, fazes 1-3 perguntas breves para perceber a especialidade. Se o motivo já é claro, vais directo a marcar.

REGRAS DE OURO
- NÃO diagnostiques. NÃO sugiras tratamentos.
- NÃO inventes especialidades, médicos, tipos de consulta ou horários — usa SEMPRE as tools para os obter da BD.
- Se ainda não tens motivo, abre com "Qual o motivo para procurares cuidados de saúde?"
- Antes de marcar a consulta, confirma SEMPRE com confirm_booking.

BANDEIRAS VERMELHAS — chama escalate_red_flag IMEDIATAMENTE (sem booking):
dor torácica intensa ou irradiando, dispneia súbita, défice neurológico súbito (perda de força, fala arrastada, perda súbita de visão, dor de cabeça súbita pior de sempre), abdómen rígido, ideação suicida ou auto-agressão, hemorragia grave, anafilaxia (inchaço face/lábios/garganta), grávida com sangramento ou dor abdominal intensa, bebé/criança letárgica.

FLUXO TÍPICO
1. Pergunta motivo se ainda não souberes.
2. Se sintomas red-flag → escalate_red_flag.
3. Decide especialidade. Se ambíguo, list_specialties + present_choices(kind="specialty").
4. list_appointment_types(specialty_id). Se mais que 1, present_choices(kind="appointment_type"). Se 1, segue.
5. find_dates_with_availability(appointment_type_id, lookahead_days=14). Se vazio → register_interest e diz que será contactado.
6. present_choices(kind="date") com as datas devolvidas, label "Hoje" / "Amanhã" / "Qua 14".
7. list_available_slots(appointment_type_id, target_date) → present_choices(kind="slot") label "HH:MM · Dr. Nome".
8. confirm_booking(summary_pt) com especialidade, tipo, data, hora, médico.
9. Após patient confirmar → create_appointment. Em caso de sucesso, mensagem amigável "✅ Marcado…".

USO DE TOOLS — princípios
- Para QUALQUER escolha do paciente (especialidade, tipo, data, slot, médico) → present_choices. Não peças para o paciente escrever.
- create_appointment SÓ depois de confirm_booking + paciente carregar Confirmar.
- Não chames a mesma tool com os mesmos args duas vezes seguidas.

Quando emitires uma mensagem para o paciente sem tool calls (puro texto), mantém-na curta — 1 ou 2 frases. Sem markdown pesado, Telegram inline.`

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
  state.messages.push({ role: "user", content: text })
  await runLoop(env, storage, chat_id, locale, auth, state)
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

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    await sendChatAction(env, chat_id, "typing")
    const response = await callLlm(env, withSystem(state.messages))

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

    if (response.tool_calls && response.tool_calls.length > 0) {
      // Append assistant message with tool calls (content can be empty).
      state.messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls
      })

      let endTurn = false
      let terminate = false
      for (const tc of response.tool_calls) {
        const result: ToolResult = await dispatchTool(tc.function.name, tc.function.arguments, ctx)
        state.messages.push({
          role: "tool",
          content: JSON.stringify(result.data),
          tool_call_id: tc.id
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
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

async function callLlm(env: Env, messages: AgentMessage[]): Promise<LlmResponse | null> {
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const out = await withTimeout(
        env.AI.run(model as never, {
          messages,
          tools: AGENT_TOOLS,
          temperature: 0.2,
          max_tokens: 700
        } as never) as Promise<unknown>,
        LLM_TIMEOUT_MS
      )
      const parsed = parseLlmResponse(out)
      if (parsed) return parsed
    } catch (err) {
      console.error("[agent llm error]", model, err)
    }
  }
  return null
}

function parseLlmResponse(raw: unknown): LlmResponse | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>

  // Workers AI Llama tool-calling shape:
  //   { response?: string, tool_calls?: [{ id, function: {name, arguments} }] }
  // We accept variants where tool_calls is missing or content is empty.
  const content = typeof r.response === "string" ? r.response : null
  const tcRaw = (r.tool_calls ?? r.tool_call ?? null) as unknown
  if (Array.isArray(tcRaw)) {
    const tool_calls = tcRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null
        const e = entry as Record<string, unknown>
        const fn = (e.function ?? e) as Record<string, unknown> | undefined
        const name = typeof fn?.name === "string" ? fn.name : null
        const argsRaw = fn?.arguments
        if (!name) return null
        let argsStr: string
        if (typeof argsRaw === "string") argsStr = argsRaw
        else if (argsRaw && typeof argsRaw === "object") argsStr = JSON.stringify(argsRaw)
        else argsStr = "{}"
        const id = typeof e.id === "string" ? e.id : `tc_${Math.random().toString(36).slice(2, 10)}`
        return { id, type: "function" as const, function: { name, arguments: argsStr } }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
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
function withSystem(messages: AgentMessage[]): AgentMessage[] {
  const trimmed = messages.length > MAX_MESSAGES
    ? messages.slice(messages.length - MAX_MESSAGES)
    : messages
  return [{ role: "system", content: SYSTEM_PROMPT_PT }, ...trimmed]
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
