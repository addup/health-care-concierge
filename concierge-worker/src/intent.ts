import type { Env } from "./env"
import type { Locale } from "./i18n"

export type Intent =
  | "GREET"
  | "FAQ"
  | "TRIAGE"
  | "BOOK"
  | "RESCHEDULE"
  | "CANCEL"
  | "LIST_APPOINTMENTS"
  | "FORM_RESPONSE"
  | "IDENTIFY"
  | "OTHER"

export interface IntentEntities {
  specialty: string | null
  date_hint: string | null
  time_hint: string | null
  appointment_ref: string | null
  symptoms: string[]
  email: string | null
}

export interface ClassifiedIntent {
  intent: Intent
  confidence: number
  entities: IntentEntities
  language: Locale
  /** "llm" when Workers AI returned a parseable JSON, "rule" on fallback. */
  source: "llm" | "rule"
}

const SYSTEM_PROMPT = `You are an intent classifier for the EqualCare clinic concierge.
Classify the patient's message into ONE intent and extract entities.

Intents:
  GREET, FAQ, TRIAGE, BOOK, RESCHEDULE, CANCEL,
  LIST_APPOINTMENTS, FORM_RESPONSE, IDENTIFY, OTHER

Output STRICT JSON, no prose:
{
  "intent": "...",
  "confidence": 0.0-1.0,
  "entities": {
    "specialty": null | "...",
    "date_hint": null | "...",
    "time_hint": null | "...",
    "appointment_ref": null | "...",
    "symptoms": [],
    "email": null | "..."
  },
  "language": "pt" | "en"
}

Rules:
- If the message describes pain or symptoms, intent is TRIAGE.
- If the message asks to schedule/book/marcar without symptoms, intent is BOOK.
- If the message asks to reschedule/move/mudar/reagendar, intent is RESCHEDULE.
- If the message asks to cancel/cancelar, intent is CANCEL.
- If the message asks "what / where / when / how" about the clinic, intent is FAQ.
- "olá" / "oi" / "hi" / "hello" → GREET.
- A bare email address → IDENTIFY.
- A 4-6 digit number → FORM_RESPONSE.
- Else OTHER.`

const VALID_INTENTS: ReadonlySet<Intent> = new Set([
  "GREET", "FAQ", "TRIAGE", "BOOK", "RESCHEDULE", "CANCEL",
  "LIST_APPOINTMENTS", "FORM_RESPONSE", "IDENTIFY", "OTHER"
])

const PRIMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct"
const LLM_TIMEOUT_MS = 2000

export async function classify(
  env: Env,
  text: string,
  hintLocale: Locale
): Promise<ClassifiedIntent> {
  // Cheap, deterministic short-circuits before paying for an LLM call.
  const ruleHit = ruleClassify(text, hintLocale)
  if (ruleHit && ruleHit.confidence >= 0.9) return ruleHit

  // LLM attempt with timeout + fallback.
  try {
    const out = await withTimeout(
      runLlm(env, PRIMARY_MODEL, text, hintLocale),
      LLM_TIMEOUT_MS
    )
    if (out) return out
  } catch {
    /* fall through */
  }
  try {
    const out = await withTimeout(
      runLlm(env, FALLBACK_MODEL, text, hintLocale),
      LLM_TIMEOUT_MS
    )
    if (out) return out
  } catch {
    /* fall through */
  }

  return ruleHit ?? defaultOther(text, hintLocale)
}

// ---------------------------------------------------------------------
// Rule-based fallback. Covers the obvious shapes well enough that the
// classifier degrades gracefully when Workers AI is cold or unreachable.
// ---------------------------------------------------------------------

function ruleClassify(text: string, hintLocale: Locale): ClassifiedIntent | null {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  const language: Locale = /^(hi|hello|hey)/.test(lower) ? "en" : hintLocale

  const baseEntities: IntentEntities = {
    specialty: null,
    date_hint: null,
    time_hint: null,
    appointment_ref: null,
    symptoms: [],
    email: null
  }

  // Email-only → IDENTIFY
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return {
      intent: "IDENTIFY",
      confidence: 0.95,
      entities: { ...baseEntities, email: trimmed.toLowerCase() },
      language,
      source: "rule"
    }
  }

  // 4-6 digit code → FORM_RESPONSE (could also be OTP, callers disambiguate)
  if (/^\d{4,6}$/.test(trimmed)) {
    return {
      intent: "FORM_RESPONSE",
      confidence: 0.95,
      entities: baseEntities,
      language,
      source: "rule"
    }
  }

  // Greetings
  if (/^(olá|ola|oi|bom\s+dia|boa\s+tarde|boa\s+noite|hi|hello|hey)\b/i.test(lower)) {
    return { intent: "GREET", confidence: 0.95, entities: baseEntities, language, source: "rule" }
  }

  // Cancel
  if (/\bcancela(r|do)?\b|\bcancel\b/i.test(lower)) {
    return { intent: "CANCEL", confidence: 0.9, entities: baseEntities, language, source: "rule" }
  }

  // Reschedule
  if (/\b(reagenda(r|do)?|mudar?\s+(a\s+)?(consulta|hora))\b|\breschedule\b|\bmove\b/i.test(lower)) {
    return { intent: "RESCHEDULE", confidence: 0.9, entities: baseEntities, language, source: "rule" }
  }

  // Book
  if (/\b(marcar?|agendar?|book|schedule)\b/i.test(lower)) {
    return { intent: "BOOK", confidence: 0.85, entities: baseEntities, language, source: "rule" }
  }

  // List
  if (/\b(minhas?\s+consultas|próxima\s+consulta|my\s+appointments?)\b/i.test(lower)) {
    return {
      intent: "LIST_APPOINTMENTS",
      confidence: 0.9,
      entities: baseEntities,
      language,
      source: "rule"
    }
  }

  // Quick FAQ keywords
  if (/\b(morada|onde\s+(é|fica)|horário|telefone|estacionamento|parking|address|hours|phone)\b/i.test(lower)) {
    return { intent: "FAQ", confidence: 0.8, entities: baseEntities, language, source: "rule" }
  }

  // Symptom hints (very conservative; LLM does the real triage triage)
  if (/\b(dor|dói|febre|tonturas|enjôo|enjoo|vómit|vomit|sangr|pain|hurts|fever|dizz|nause)\b/i.test(lower)) {
    return { intent: "TRIAGE", confidence: 0.7, entities: baseEntities, language, source: "rule" }
  }

  return null
}

// ---------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------

interface AiRunResult {
  response?: string
}

async function runLlm(
  env: Env,
  model: string,
  text: string,
  hintLocale: Locale
): Promise<ClassifiedIntent | null> {
  // Workers AI's run signature differs between models but most accept
  // { messages, response_format }. We force a JSON response.
  const result = (await env.AI.run(model as never, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  } as never)) as AiRunResult

  const raw = result?.response
  if (!raw) return null
  return parseLlmJson(raw, hintLocale)
}

function parseLlmJson(raw: string, hintLocale: Locale): ClassifiedIntent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Some models wrap the JSON in markdown fences; strip and retry.
    const stripped = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim()
    try {
      parsed = JSON.parse(stripped)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  const intent = String(obj.intent ?? "").toUpperCase() as Intent
  if (!VALID_INTENTS.has(intent)) return null

  const entitiesRaw = (obj.entities as Record<string, unknown> | undefined) ?? {}
  const symptomsRaw = entitiesRaw.symptoms
  const language = obj.language === "en" ? "en" : hintLocale

  return {
    intent,
    confidence: clampConfidence(obj.confidence),
    entities: {
      specialty: stringOrNull(entitiesRaw.specialty),
      date_hint: stringOrNull(entitiesRaw.date_hint),
      time_hint: stringOrNull(entitiesRaw.time_hint),
      appointment_ref: stringOrNull(entitiesRaw.appointment_ref),
      symptoms: Array.isArray(symptomsRaw)
        ? symptomsRaw.filter((s): s is string => typeof s === "string")
        : [],
      email: stringOrNull(entitiesRaw.email)
    },
    language,
    source: "llm"
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return 0.5
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function defaultOther(_text: string, hintLocale: Locale): ClassifiedIntent {
  return {
    intent: "OTHER",
    confidence: 0.3,
    entities: {
      specialty: null,
      date_hint: null,
      time_hint: null,
      appointment_ref: null,
      symptoms: [],
      email: null
    },
    language: hintLocale,
    source: "rule"
  }
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
