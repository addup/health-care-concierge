/**
 * Generic form runner state machine.
 *
 * - startForm(dispatch_id) loads the dispatch + template, marks the
 *   dispatch as sent (idempotent), and renders question 0.
 * - handleAnswer(callback) is invoked when the patient taps an inline
 *   answer button (callback `f:<dispatch>:q:<idx>:a:<val>`). Advances
 *   the cursor; on the last question, scores and persists the response.
 * - handleText() handles free-text answers mid-flow.
 *
 * State key: "form_state".
 */

import type { Env } from "../env"
import { sendMessage, type ReplyMarkup } from "../telegram"
import { serviceClient } from "../supabase"
import { logAction } from "../audit"
import type { Json } from "../../../shared/db-types-concierge"
import {
  type FormState,
  type Locale,
  type Question,
  type TemplateSchema,
  type Likert5Q,
  type Likert5InverseQ,
  type VasQ,
  type ScaleQ,
  promptFor,
  labelsFor
} from "./types"
import { scorePREM } from "./prem"
import { scoreEQ5D5L } from "./eq5d5l"

const STORAGE_KEY = "form_state"

/**
 * Begin (or resume) a form for the patient. Idempotent on dispatch_id —
 * if a form_state for the same dispatch already exists in DO storage,
 * we re-render the current question instead of restarting.
 */
export async function startForm(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  dispatch_id: string
): Promise<void> {
  const existing = await storage.get<FormState>(STORAGE_KEY)
  if (existing && existing.dispatch_id === dispatch_id) {
    // Resume.
    await renderQuestion(env, chat_id, locale, existing)
    return
  }

  // Look up dispatch + template via service role (the patient's session
  // can't necessarily read templates if RLS is tight — though we made
  // them world-readable, service is more reliable).
  const svc = serviceClient(env)
  const { data: dispatch } = await svc
    .from("concierge_form_dispatches")
    .select("id, template_id, completed_at, abandoned_at")
    .eq("id", dispatch_id)
    .maybeSingle()
  if (!dispatch) {
    await sendMessage(env, chat_id, fallbackCopy(locale, "form_dispatch_not_found"))
    return
  }
  if (dispatch.completed_at || dispatch.abandoned_at) {
    // Already done — silently ignore re-trigger.
    return
  }

  const { data: template } = await svc
    .from("concierge_form_templates")
    .select("id, schema")
    .eq("id", dispatch.template_id)
    .maybeSingle()
  if (!template?.schema) {
    await sendMessage(env, chat_id, fallbackCopy(locale, "form_template_missing"))
    return
  }
  const schema = template.schema as unknown as TemplateSchema
  if (!schema.questions || schema.questions.length === 0) {
    await sendMessage(env, chat_id, fallbackCopy(locale, "form_template_missing"))
    return
  }

  // Mark sent (idempotent — RPC won't overwrite a sent_at).
  await svc.rpc("mark_concierge_form_sent", {
    p_dispatch_id: dispatch_id,
    p_is_reminder: false
  })

  const state: FormState = {
    dispatch_id,
    template_id: template.id,
    template_schema: schema,
    cursor: 0,
    answers: {},
    awaiting_text: false,
    chat_id
  }
  await storage.put(STORAGE_KEY, state)
  await renderQuestion(env, chat_id, locale, state)
}

/**
 * Inline-button answer. `payload` is the raw `:q:<idx>:a:<val>` portion
 * of the callback (callers strip the `f:<dispatch>:` prefix).
 */
export async function handleAnswerCallback(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  dispatchId: string,
  qIdx: number,
  rawValue: string
): Promise<void> {
  const state = await storage.get<FormState>(STORAGE_KEY)
  if (!state || state.dispatch_id !== dispatchId) return  // stale callback
  if (qIdx !== state.cursor) return                       // out-of-order tap

  const q = state.template_schema.questions[qIdx]
  if (!q) return

  const value = parseValue(q, rawValue)
  if (value === null) return  // ignore malformed
  state.answers[q.id] = value
  await advance(env, storage, chat_id, locale, state)
}

/**
 * Free-text answer. Used for `free_text` question types only.
 */
export async function handleText(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  text: string
): Promise<void> {
  const state = await storage.get<FormState>(STORAGE_KEY)
  if (!state || !state.awaiting_text) return
  const q = state.template_schema.questions[state.cursor]
  if (!q || q.type !== "free_text") return

  state.answers[q.id] = text.trim()
  state.awaiting_text = false
  await advance(env, storage, chat_id, locale, state)
}

// ---------------------------------------------------------------------
// Internal: advance / render / score
// ---------------------------------------------------------------------

async function advance(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  state: FormState
): Promise<void> {
  state.cursor += 1
  if (state.cursor >= state.template_schema.questions.length) {
    await finish(env, storage, chat_id, locale, state)
    return
  }
  await storage.put(STORAGE_KEY, state)
  await renderQuestion(env, chat_id, locale, state)
}

async function renderQuestion(
  env: Env,
  chat_id: number,
  locale: Locale,
  state: FormState
): Promise<void> {
  const q = state.template_schema.questions[state.cursor]
  if (!q) return
  const prompt = promptFor(q, locale)

  switch (q.type) {
    case "scale": {
      const reply_markup = scaleKeyboard(state.dispatch_id, state.cursor, q)
      await sendMessage(env, chat_id, prompt, reply_markup)
      state.awaiting_text = false
      return
    }
    case "likert5":
    case "likert5_inverse": {
      const reply_markup = likert5Keyboard(state.dispatch_id, state.cursor, q, locale)
      await sendMessage(env, chat_id, prompt, reply_markup)
      state.awaiting_text = false
      return
    }
    case "vas": {
      const reply_markup = vasKeyboard(state.dispatch_id, state.cursor, q)
      await sendMessage(env, chat_id, prompt, reply_markup)
      state.awaiting_text = false
      return
    }
    case "free_text": {
      // No buttons; just prompt and remember we expect a text reply next.
      // For optional questions, also offer a "skip" button.
      const reply_markup = q.optional
        ? {
            inline_keyboard: [[
              {
                text: locale === "en" ? "Skip" : "Saltar",
                callback_data: `f:${state.dispatch_id}:q:${state.cursor}:a:__skip__`
              }
            ]]
          }
        : undefined
      await sendMessage(env, chat_id, prompt, reply_markup)
      state.awaiting_text = true
      return
    }
  }
}

async function finish(
  env: Env,
  storage: DurableObjectStorage,
  chat_id: number,
  locale: Locale,
  state: FormState
): Promise<void> {
  const score = computeScore(state.template_id, state.answers, locale)
  const svc = serviceClient(env)
  await svc.rpc("record_concierge_form_response", {
    p_dispatch_id: state.dispatch_id,
    p_answers: state.answers as unknown as Json,
    p_score: score as unknown as Json
  })
  await logAction(env, {
    patient_id: null,         // we don't carry patient_id here; rpc derives it
    telegram_user_id: chat_id,
    intent: "FORM_RESPONSE",
    action: "form_completed",
    payload: { dispatch_id: state.dispatch_id, template_id: state.template_id }
  })
  await storage.delete(STORAGE_KEY)
  await sendMessage(env, chat_id, locale === "en"
    ? "Thanks! Your feedback helps the clinic improve."
    : "Obrigado! O teu feedback ajuda a clínica a melhorar.")
}

function computeScore(
  template_id: string,
  answers: Record<string, number | string>,
  locale: Locale
): unknown {
  if (template_id === "PREM_v1") return scorePREM(answers)
  if (template_id === "EQ5D5L_v1") return scoreEQ5D5L(answers, locale)
  return { raw: answers }
}

// ---------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------

function scaleKeyboard(dispatch_id: string, qIdx: number, q: ScaleQ): ReplyMarkup {
  // 0..10 split into two rows: 0-5 then 6-10 (works for NPS).
  const rows: ReplyMarkup["inline_keyboard"] = []
  let row: { text: string; callback_data: string }[] = []
  for (let v = q.min; v <= q.max; v++) {
    row.push({ text: String(v), callback_data: `f:${dispatch_id}:q:${qIdx}:a:${v}` })
    if (row.length === 6) {
      rows!.push(row)
      row = []
    }
  }
  if (row.length > 0) rows!.push(row)
  return { inline_keyboard: rows }
}

function likert5Keyboard(
  dispatch_id: string,
  qIdx: number,
  q: Likert5Q | Likert5InverseQ,
  locale: Locale
): ReplyMarkup {
  const labels = labelsFor(q, locale) ?? ["1", "2", "3", "4", "5"]
  // Stack vertically — labels are too long for one row.
  return {
    inline_keyboard: [1, 2, 3, 4, 5].map((v) => [
      {
        text: `${v}. ${labels[v - 1] ?? ""}`.slice(0, 60),
        callback_data: `f:${dispatch_id}:q:${qIdx}:a:${v}`
      }
    ])
  }
}

function vasKeyboard(dispatch_id: string, qIdx: number, q: VasQ): ReplyMarkup {
  const rows: ReplyMarkup["inline_keyboard"] = []
  let row: { text: string; callback_data: string }[] = []
  for (let v = q.min; v <= q.max; v += q.step) {
    row.push({ text: String(v), callback_data: `f:${dispatch_id}:q:${qIdx}:a:${v}` })
    if (row.length === 6) {
      rows!.push(row)
      row = []
    }
  }
  if (row.length > 0) rows!.push(row)
  return { inline_keyboard: rows }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function parseValue(q: Question, raw: string): number | string | null {
  if (q.type === "free_text") {
    if (raw === "__skip__") return ""
    return raw
  }
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return null
  if (q.type === "scale") {
    if (n < q.min || n > q.max) return null
    return n
  }
  if (q.type === "vas") {
    if (n < q.min || n > q.max || n % q.step !== 0) return null
    return n
  }
  if (n < 1 || n > 5) return null
  return n
}

function fallbackCopy(locale: Locale, kind: "form_dispatch_not_found" | "form_template_missing"): string {
  if (locale === "en") {
    return kind === "form_dispatch_not_found"
      ? "I can't find that survey link. It may have expired."
      : "Sorry, that survey is unavailable right now."
  }
  return kind === "form_dispatch_not_found"
    ? "Não encontrei esse questionário. Pode ter expirado."
    : "Esse questionário não está disponível neste momento."
}
