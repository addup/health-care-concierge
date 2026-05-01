import type { Env } from "./env"
import { sendMessage, sendChatAction } from "./telegram"
import { t, type Locale } from "./i18n"
import { logAction } from "./audit"
import { startBooking } from "./booking"

export interface TriageState {
  turn: number  // number of bot questions asked so far (0..MAX_TURNS)
  history: Array<{ role: "patient" | "bot"; text: string }>
  initial_complaint: string
}

interface AuthCtx {
  patient_id: string
  access_token: string
}

const STORAGE_KEY = "triage_state"
const MAX_TURNS = 4
const TRIAGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
const TRIAGE_FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct"
const LLM_TIMEOUT_MS = 4000

// Conservative red-flag pre-check. Bias toward false positives — a missed
// emergency is the costly failure mode. Same patterns checked again by the
// LLM, but a regex hit short-circuits without an LLM call.
const RED_FLAG_REGEX = new RegExp(
  [
    // Cardiac
    "dor\\s+(forte|intensa|aguda)?\\s*no\\s+peito",
    "aperto\\s+no\\s+peito",
    "chest\\s+pain",
    "irradi(a|ar|ando)\\s+para\\s+o\\s+bra[çc]o",
    "radiating\\s+to\\s+(my\\s+)?arm",
    // Respiratory
    "falta\\s+de\\s+ar\\s+s[úu]bita",
    "dispneia\\s+s[úu]bita",
    "sudden\\s+shortness\\s+of\\s+breath",
    "anafil(axia|axis)",
    "anaphylaxis",
    "incho\\s+(na|nos)\\s+(cara|l[áa]bios|garganta)",
    "swelling\\s+of\\s+(face|lips|throat|tongue)",
    // Neurological
    "perda\\s+de\\s+for[çc]a\\s+(de\\s+um\\s+lado|num\\s+lado)",
    "weakness\\s+on\\s+one\\s+side",
    "fala\\s+arrastada",
    "slurred\\s+speech",
    "perda\\s+de\\s+vis[ãa]o\\s+s[úu]bita",
    "sudden\\s+vision\\s+loss",
    "(pior|worst)\\s+dor\\s+de\\s+cabe[çc]a\\s+(da\\s+minha\\s+vida|de\\s+sempre)",
    "thunderclap\\s+headache",
    "worst\\s+headache\\s+of\\s+my\\s+life",
    // Abdominal
    "abd[óo]men\\s+r[íi]gido",
    "rigid\\s+abdomen",
    // Bleeding
    "hemorragia\\s+(grave|abundante)",
    "heavy\\s+bleeding",
    // Psychiatric
    "(ideias?\\s+suicidas?|ideacao\\s+suicida|vou\\s+matar-me|n[ãa]o\\s+quero\\s+viver)",
    "(suicidal|kill\\s+myself|want\\s+to\\s+die|self[\\s-]?harm)",
    // Pregnancy emergency
    "gr[áa]vida.{0,20}(sangr|hemorragi)",
    "pregnant.{0,20}bleeding",
    // Pediatric (very rough)
    "beb[éê]\\s+letar"
  ].join("|"),
  "i"
)

export function detectRedFlag(text: string): boolean {
  return RED_FLAG_REGEX.test(text)
}

// ---------------------------------------------------------------------
// Entry — TRIAGE intent or symptom-shaped initial message
// ---------------------------------------------------------------------

export async function startTriage(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  complaint: string
): Promise<void> {
  await storage.delete(STORAGE_KEY)

  if (detectRedFlag(complaint)) {
    await sendMessage(env, chat_id, t(locale, "triage_red_flag"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "TRIAGE",
      action: "triage_red_flag_pre_llm",
      payload: { complaint }
    })
    return
  }

  await sendChatAction(env, chat_id, "typing")
  const state: TriageState = {
    turn: 0,
    history: [{ role: "patient", text: complaint }],
    initial_complaint: complaint
  }
  await advanceTriage(env, storage, chat_id, locale, auth, state)
}

// ---------------------------------------------------------------------
// Subsequent free-text turns (called by patient-agent when triage_state
// exists in storage, before intent classification).
// ---------------------------------------------------------------------

export async function handleTriageReply(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  text: string
): Promise<void> {
  const state = await storage.get<TriageState>(STORAGE_KEY)
  if (!state) return  // shouldn't happen — caller should have checked

  // Re-check red-flag on every patient reply (sometimes the trigger
  // shows up only after a follow-up question).
  if (detectRedFlag(text)) {
    await storage.delete(STORAGE_KEY)
    await sendMessage(env, chat_id, t(locale, "triage_red_flag"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "TRIAGE",
      action: "triage_red_flag_mid_flow",
      payload: { reply: text }
    })
    return
  }

  state.history.push({ role: "patient", text })
  await sendChatAction(env, chat_id, "typing")
  await advanceTriage(env, storage, chat_id, locale, auth, state)
}

// ---------------------------------------------------------------------
// Core: ask the LLM what to do next.
// ---------------------------------------------------------------------

async function advanceTriage(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  auth: AuthCtx,
  state: TriageState
): Promise<void> {
  // Hard cap — fall back to default specialty.
  if (state.turn >= MAX_TURNS) {
    await storage.delete(STORAGE_KEY)
    await sendMessage(env, chat_id, t(locale, "triage_max_turns"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "TRIAGE",
      action: "triage_max_turns_default",
      payload: { history: state.history }
    })
    await startBooking(env, storage, chat_id, locale, auth, "Medicina Geral")
    return
  }

  const decision = await runTriageLlm(env, locale, state)
  if (!decision) {
    // LLM unreachable — be conservative, default to MG and book.
    await storage.delete(STORAGE_KEY)
    await sendMessage(env, chat_id, t(locale, "triage_failed"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "TRIAGE",
      action: "triage_llm_failed",
      payload: {}
    })
    await startBooking(env, storage, chat_id, locale, auth, "Medicina Geral")
    return
  }

  if (decision.kind === "ask") {
    state.history.push({ role: "bot", text: decision.question })
    state.turn += 1
    await storage.put(STORAGE_KEY, state)
    await sendMessage(env, chat_id, decision.question)
    return
  }

  // decision.kind === "done"
  if (decision.urgency === "red_flag") {
    await storage.delete(STORAGE_KEY)
    await sendMessage(env, chat_id, t(locale, "triage_red_flag"))
    await logAction(env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: "TRIAGE",
      action: "triage_red_flag_llm",
      payload: { summary: decision.summary, specialty: decision.specialty }
    })
    return
  }

  // routine | soon → handoff to booking with specialty hint.
  await storage.delete(STORAGE_KEY)
  const handoffKey = decision.urgency === "soon" ? "triage_handoff_soon" : "triage_handoff_routine"
  await sendMessage(env, chat_id, t(locale, handoffKey, { specialty: decision.specialty }))
  await logAction(env, {
    patient_id: auth.patient_id,
    telegram_user_id: chat_id,
    intent: "TRIAGE",
    action: "triage_handoff",
    payload: { specialty: decision.specialty, urgency: decision.urgency, summary: decision.summary }
  })
  await startBooking(env, storage, chat_id, locale, auth, decision.specialty)
}

// ---------------------------------------------------------------------
// LLM wrapper
// ---------------------------------------------------------------------

type TriageDecision =
  | { kind: "ask"; question: string }
  | { kind: "done"; specialty: string; urgency: "routine" | "soon" | "red_flag"; summary: string }

const TRIAGE_SYSTEM_PT = `És um clínico geral a fazer triagem inicial num concierge de clínica em Portugal. Conversas em PT-PT.
NÃO diagnostiques. NÃO sugiras tratamento. Tom calmo, frases curtas.
Faz UMA pergunta breve de cada vez para perceber: localização, duração, severidade (0-10), sintomas associados.
Após 2 a 4 perguntas, OU se já tens informação suficiente, decide a especialidade adequada.

Bandeiras vermelhas (urgency=red_flag, sem marcação): dor torácica intensa, dispneia súbita, défice neurológico súbito, abdómen agudo rígido, ideação suicida, hemorragia grave, anafilaxia.

Devolve SEMPRE APENAS JSON, sem prosa antes ou depois.

Se ainda precisas de mais info:
{"done": false, "next_question": "..."}

Se já consegues concluir:
{"done": true, "specialty": "Medicina Geral" | "Nutrição" | "Psicologia" | "...", "urgency": "routine" | "soon" | "red_flag", "summary": "1-2 frases curtas"}`

const TRIAGE_SYSTEM_EN = `You are a GP doing initial triage for a clinic concierge. Conversations in English.
Do NOT diagnose. Do NOT suggest treatment. Calm tone, short sentences.
Ask ONE brief question at a time to understand: location, duration, severity (0-10), associated symptoms.
After 2-4 questions, OR if you have enough info, decide the appropriate specialty.

Red flags (urgency=red_flag, no booking): severe chest pain, sudden dyspnea, sudden focal neuro deficit, rigid acute abdomen, suicidal ideation, severe bleeding, anaphylaxis.

Return ONLY JSON, no prose.

If you still need info:
{"done": false, "next_question": "..."}

When ready:
{"done": true, "specialty": "General Medicine" | "Nutrition" | "Psychology" | "...", "urgency": "routine" | "soon" | "red_flag", "summary": "1-2 short sentences"}`

async function runTriageLlm(
  env: Env,
  locale: Locale,
  state: TriageState
): Promise<TriageDecision | null> {
  const system = locale === "pt" ? TRIAGE_SYSTEM_PT : TRIAGE_SYSTEM_EN
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system }
  ]
  for (const turn of state.history) {
    messages.push({ role: turn.role === "patient" ? "user" : "assistant", content: turn.text })
  }

  // Try primary, then fallback. Each with a timeout.
  for (const model of [TRIAGE_MODEL, TRIAGE_FALLBACK_MODEL]) {
    try {
      const out = await withTimeout(
        env.AI.run(model as never, {
          messages,
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 300
        } as never) as Promise<{ response?: string }>,
        LLM_TIMEOUT_MS
      )
      const parsed = parseTriageJson(out?.response ?? "")
      if (parsed) return parsed
    } catch {
      /* try next */
    }
  }
  return null
}

function parseTriageJson(raw: string): TriageDecision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const stripped = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
    try {
      parsed = JSON.parse(stripped)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  if (obj.done === false || obj.done === "false") {
    const q = typeof obj.next_question === "string" ? obj.next_question.trim() : ""
    if (!q) return null
    return { kind: "ask", question: q }
  }

  if (obj.done === true || obj.done === "true") {
    const specialty = typeof obj.specialty === "string" ? obj.specialty.trim() : ""
    const urgency = obj.urgency
    const summary = typeof obj.summary === "string" ? obj.summary : ""
    if (!specialty) return null
    if (urgency !== "routine" && urgency !== "soon" && urgency !== "red_flag") return null
    return { kind: "done", specialty, urgency, summary }
  }

  return null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
