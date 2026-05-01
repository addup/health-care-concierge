import type { Env } from "./env"
import {
  sendMessage,
  sendChatAction,
  answerCallbackQuery,
  type TelegramMessage,
  type TelegramCallbackQuery,
  type TelegramUpdate,
  type ReplyMarkup
} from "./telegram"
import { anonClient, serviceClient } from "./supabase"
import { t, detectLocaleFromText, DEFAULT_LOCALE, type Locale } from "./i18n"
import { classify, type ClassifiedIntent } from "./intent"
import { logAction } from "./audit"
import {
  startBooking,
  handleSpecialtyChoice,
  handleTypeChoice,
  handleDateChoice,
  handleSlotChoice
} from "./booking"
import {
  listMyAppointments,
  startReschedule,
  handleReschedulePick,
  handleRescheduleDate,
  handleRescheduleSlot,
  startCancel,
  handleCancelPick,
  handleCancelConfirm
} from "./appointments"
import { faqLookup } from "./faq"
import { startTriage, handleTriageReply, type TriageState } from "./triage"
import {
  startForm,
  handleAnswerCallback as handleFormAnswer,
  handleText as handleFormText
} from "./forms/runner"
import type { FormState } from "./forms/types"

interface AuthState {
  patient_id: string
  access_token: string
  refresh_token: string
  chosen_name: string | null
  registration_completed: boolean
  linked_at: string
}

interface PendingOtpState {
  email: string
  attempts: number
  expires_at: number
}

const PENDING_OTP_TTL_MS = 10 * 60 * 1000
const MAX_OTP_ATTEMPTS = 5

export class PatientAgent implements DurableObject {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method-not-allowed", { status: 405 })
    }
    let body: {
      update?: TelegramUpdate
      dispatch?: {
        type: "form_dispatch" | "reminder"
        chat_id: number
        dispatch_id?: string
        text?: string  // pre-rendered reminder text, used by Phase 5
      }
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return new Response("bad-request", { status: 400 })
    }

    try {
      if (body.update) {
        if (body.update.message) await this.handleMessage(body.update.message)
        else if (body.update.callback_query) await this.handleCallback(body.update.callback_query)
      } else if (body.dispatch) {
        await this.handleExternalDispatch(body.dispatch)
      } else {
        return new Response("bad-request", { status: 400 })
      }
    } catch (err) {
      // Don't let one bad turn poison the chat — log and ack.
      console.error("PatientAgent.fetch error", err)
    }
    return new Response("ok", { status: 200 })
  }

  private async handleExternalDispatch(d: {
    type: "form_dispatch" | "reminder"
    chat_id: number
    dispatch_id?: string
    text?: string
  }): Promise<void> {
    const locale = (await this.state.storage.get<Locale>("locale")) ?? DEFAULT_LOCALE

    if (d.type === "form_dispatch" && d.dispatch_id) {
      // Drop any in-flight conversational state — a dispatched form
      // takes the whole turn.
      await this.state.storage.delete(["booking_state", "reschedule_state", "cancel_state", "triage_state"])
      await startForm(this.env, this.state.storage, d.chat_id, locale, d.dispatch_id)
      return
    }
    if (d.type === "reminder" && d.text) {
      await sendMessage(this.env, d.chat_id, d.text)
      return
    }
  }

  // ---------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.text) return
    const chat_id = message.chat.id
    const text = message.text.trim()

    const locale = await this.ensureLocale(text)

    if (text.startsWith("/start")) {
      await this.handleStart(chat_id, locale)
      return
    }
    if (text.startsWith("/cancel") || text.startsWith("/reset")) {
      await this.state.storage.delete([
        "pending_otp",
        "booking_state",
        "reschedule_state",
        "cancel_state",
        "triage_state",
        "form_state"
      ])
      await sendMessage(this.env, chat_id, t(locale, "reset_state"))
      return
    }
    if (text.startsWith("/help")) {
      await sendMessage(this.env, chat_id, t(locale, "welcome_unlinked"))
      return
    }

    const pending = await this.state.storage.get<PendingOtpState>("pending_otp")
    if (pending) {
      await this.handleOtpAttempt(chat_id, locale, pending, text)
      return
    }

    const auth = await this.state.storage.get<AuthState>("auth")
    if (!auth) {
      // No auth yet — treat free text as an email attempt.
      await this.handleEmailEntry(chat_id, locale, text)
      return
    }

    if (!auth.registration_completed) {
      await sendMessage(
        this.env,
        chat_id,
        t(locale, "registration_incomplete", { app_url: this.env.PLATFORM_APP_URL })
      )
      return
    }

    // Mid-form hijack: free text is a free_text answer to the current
    // form question. Forms always take priority over triage and intent
    // because they are time-bounded surveys.
    const formState = await this.state.storage.get<FormState>("form_state")
    if (formState?.awaiting_text) {
      await handleFormText(this.env, this.state.storage, chat_id, locale, text)
      return
    }

    // Mid-triage hijack: while triage_state is set, free text is the
    // patient's reply to the bot's question, NOT a new intent.
    const triageState = await this.state.storage.get<TriageState>("triage_state")
    if (triageState) {
      await handleTriageReply(
        this.env,
        this.state.storage,
        chat_id,
        locale,
        { patient_id: auth.patient_id, access_token: auth.access_token },
        text
      )
      return
    }

    // Authed + registration_completed. Classify intent and route.
    await sendChatAction(this.env, chat_id, "typing")
    const classified = await classify(this.env, text, locale)
    await logAction(this.env, {
      patient_id: auth.patient_id,
      telegram_user_id: chat_id,
      intent: classified.intent,
      action: "intent_classified",
      payload: {
        text,
        confidence: classified.confidence,
        source: classified.source,
        entities: classified.entities
      }
    })
    await this.dispatchIntent(chat_id, locale, auth, classified, text)
  }

  /**
   * Routes intents. RESCHEDULE / CANCEL / LIST_APPOINTMENTS land in 2c;
   * FAQ in 2d; TRIAGE in 3; FORM_RESPONSE in 4. BOOK is live as of 2b.
   */
  private async dispatchIntent(
    chat_id: number,
    locale: Locale,
    auth: AuthState,
    classified: ClassifiedIntent,
    rawText: string
  ): Promise<void> {
    switch (classified.intent) {
      case "GREET":
      case "IDENTIFY":
        await this.greetLinked(chat_id, locale, auth.chosen_name)
        return
      case "BOOK":
        await startBooking(
          this.env,
          this.state.storage,
          chat_id,
          locale,
          { patient_id: auth.patient_id, access_token: auth.access_token },
          classified.entities.specialty
        )
        return
      case "LIST_APPOINTMENTS":
        await listMyAppointments(this.env, chat_id, locale, {
          patient_id: auth.patient_id,
          access_token: auth.access_token
        })
        return
      case "RESCHEDULE":
        await startReschedule(this.env, this.state.storage, chat_id, locale, {
          patient_id: auth.patient_id,
          access_token: auth.access_token
        })
        return
      case "CANCEL":
        await startCancel(this.env, this.state.storage, chat_id, locale, {
          patient_id: auth.patient_id,
          access_token: auth.access_token
        })
        return
      case "FAQ":
        await faqLookup(this.env, chat_id, rawText, locale)
        return
      case "TRIAGE":
        await startTriage(
          this.env,
          this.state.storage,
          chat_id,
          locale,
          { patient_id: auth.patient_id, access_token: auth.access_token },
          rawText
        )
        return
      case "FORM_RESPONSE":
      case "OTHER":
      default:
        await sendMessage(this.env, chat_id, t(locale, "feature_in_construction"))
        return
    }
  }

  private async handleStart(chat_id: number, locale: Locale): Promise<void> {
    const auth = await this.state.storage.get<AuthState>("auth")
    if (auth?.registration_completed) {
      await this.greetLinked(chat_id, locale, auth.chosen_name)
      return
    }
    if (auth && !auth.registration_completed) {
      await sendMessage(
        this.env,
        chat_id,
        t(locale, "registration_incomplete", { app_url: this.env.PLATFORM_APP_URL })
      )
      return
    }
    await this.state.storage.delete("pending_otp")
    await sendMessage(this.env, chat_id, t(locale, "welcome_unlinked"))
  }

  private async handleEmailEntry(
    chat_id: number,
    locale: Locale,
    text: string
  ): Promise<void> {
    const email = text.trim().toLowerCase()
    if (!isValidEmail(email)) {
      await sendMessage(this.env, chat_id, t(locale, "invalid_email"))
      return
    }

    await sendChatAction(this.env, chat_id, "typing")
    const sb = anonClient(this.env)
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false }
    })

    if (error) {
      // Supabase doesn't reliably distinguish "user not found" from other
      // errors. We collapse them into a single "create your account first"
      // message — safest UX.
      await sendMessage(
        this.env,
        chat_id,
        t(locale, "email_not_found", { app_url: this.env.PLATFORM_APP_URL })
      )
      return
    }

    const pending: PendingOtpState = {
      email,
      attempts: 0,
      expires_at: Date.now() + PENDING_OTP_TTL_MS
    }
    await this.state.storage.put("pending_otp", pending)
    await sendMessage(this.env, chat_id, t(locale, "otp_sent"))
  }

  private async handleOtpAttempt(
    chat_id: number,
    locale: Locale,
    pending: PendingOtpState,
    raw: string
  ): Promise<void> {
    if (Date.now() > pending.expires_at) {
      await this.state.storage.delete("pending_otp")
      await sendMessage(this.env, chat_id, t(locale, "otp_expired"))
      return
    }
    if (pending.attempts >= MAX_OTP_ATTEMPTS) {
      await this.state.storage.delete("pending_otp")
      await sendMessage(this.env, chat_id, t(locale, "otp_too_many_attempts"))
      return
    }

    // Accept 4-10 digits — Supabase OTP length is project-configurable.
    // The MicroCare project sends 8-digit codes; default Supabase is 6.
    const code = raw.replace(/\D/g, "")
    if (code.length < 4 || code.length > 10) {
      await this.bumpOtpAttempt(pending)
      await sendMessage(this.env, chat_id, t(locale, "otp_invalid"))
      return
    }

    await sendChatAction(this.env, chat_id, "typing")
    const sb = anonClient(this.env)
    const { data, error } = await sb.auth.verifyOtp({
      email: pending.email,
      token: code,
      type: "email"
    })

    if (error || !data?.user || !data?.session) {
      await this.bumpOtpAttempt(pending)
      await sendMessage(this.env, chat_id, t(locale, "otp_invalid"))
      return
    }

    const patient_id = data.user.id
    const access_token = data.session.access_token
    const refresh_token = data.session.refresh_token

    // Pull profile fields we care about (service role: avoid an extra RLS round-trip
    // before we even know the registration state).
    const svc = serviceClient(this.env)
    const { data: profile } = await svc
      .from("profiles")
      .select("chosen_name, registration_completed")
      .eq("id", patient_id)
      .maybeSingle()

    const chosen_name = profile?.chosen_name ?? null
    const registration_completed = profile?.registration_completed ?? false

    const authState: AuthState = {
      patient_id,
      access_token,
      refresh_token,
      chosen_name,
      registration_completed,
      linked_at: new Date().toISOString()
    }
    await this.state.storage.put("auth", authState)
    await this.state.storage.delete("pending_otp")

    if (!registration_completed) {
      // Don't link Telegram for unfinished accounts. Patient retries /start
      // after completing registration in the app.
      await sendMessage(
        this.env,
        chat_id,
        t(locale, "registration_incomplete", { app_url: this.env.PLATFORM_APP_URL })
      )
      return
    }

    // Persist Telegram ↔ patient mapping and audit.
    await svc.rpc("concierge_link_telegram", {
      p_telegram_user_id: chat_id,
      p_patient_id: patient_id,
      p_locale: locale
    })
    await svc.rpc("log_concierge_action", {
      p_patient_id: patient_id,
      p_telegram_user_id: chat_id,
      p_intent: null,
      p_action: "link_telegram",
      p_payload: {}
    })

    await this.greetLinked(chat_id, locale, chosen_name)
  }

  // ---------------------------------------------------------------------
  // Callback handling (Phase 1: menu stubs)
  // ---------------------------------------------------------------------

  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    await answerCallbackQuery(this.env, cb.id)
    if (!cb.message || !cb.data) return
    const chat_id = cb.message.chat.id
    const locale = (await this.state.storage.get<Locale>("locale")) ?? DEFAULT_LOCALE
    const auth = await this.state.storage.get<AuthState>("auth")

    // Booking-flow callbacks all need the patient session.
    if (auth?.registration_completed) {
      const ctx = { patient_id: auth.patient_id, access_token: auth.access_token }
      const [prefix, payload] = splitCallback(cb.data)
      switch (prefix) {
        case "menu":
          if (payload === "book") {
            await startBooking(this.env, this.state.storage, chat_id, locale, ctx)
            return
          }
          if (payload === "list") {
            await listMyAppointments(this.env, chat_id, locale, ctx)
            return
          }
          // faq → Phase 2d
          await sendMessage(this.env, chat_id, t(locale, "feature_in_construction"))
          return
        case "s":
          await handleSpecialtyChoice(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        case "t":
          await handleTypeChoice(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        case "d":
          await handleDateChoice(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        case "b":
          await handleSlotChoice(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        // Reschedule
        case "rp":
          await handleReschedulePick(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        case "rd":
          await handleRescheduleDate(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        case "rs":
          await handleRescheduleSlot(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        // Cancel
        case "xp":
          await handleCancelPick(this.env, this.state.storage, chat_id, locale, ctx, payload)
          return
        case "xc":
          if (payload === "0" || payload === "1") {
            await handleCancelConfirm(this.env, this.state.storage, chat_id, locale, ctx, payload)
          }
          return
        // Form answers: callback format `f:<dispatch>:q:<idx>:a:<val>`.
        // Whole `cb.data` is what we have; payload here is everything
        // after the first ":". Re-parse properly.
        case "f": {
          const parts = cb.data.split(":")  // [ "f", dispatch, "q", idx, "a", val? ... ]
          const dispatchId = parts[1]
          const qIdx = parseInt(parts[3] ?? "", 10)
          const rawValue = parts.slice(5).join(":")
          if (!dispatchId || !Number.isFinite(qIdx)) return
          await handleFormAnswer(
            this.env,
            this.state.storage,
            chat_id,
            locale,
            dispatchId,
            qIdx,
            rawValue
          )
          return
        }
        default:
          await sendMessage(this.env, chat_id, t(locale, "feature_in_construction"))
          return
      }
    }

    await sendMessage(this.env, chat_id, t(locale, "feature_in_construction"))
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async greetLinked(
    chat_id: number,
    locale: Locale,
    chosen_name: string | null
  ): Promise<void> {
    const name = chosen_name?.trim() || (locale === "pt" ? "amigo" : "friend")
    const reply_markup: ReplyMarkup = {
      inline_keyboard: [
        [{ text: t(locale, "main_menu_book"), callback_data: "menu:book" }],
        [{ text: t(locale, "main_menu_my_appts"), callback_data: "menu:list" }],
        [{ text: t(locale, "main_menu_faq"), callback_data: "menu:faq" }]
      ]
    }
    await sendMessage(this.env, chat_id, t(locale, "welcome_linked", { name }), reply_markup)
  }

  private async ensureLocale(text: string): Promise<Locale> {
    const stored = await this.state.storage.get<Locale>("locale")
    if (stored) return stored
    const detected = detectLocaleFromText(text)
    await this.state.storage.put("locale", detected)
    return detected
  }

  private async bumpOtpAttempt(pending: PendingOtpState): Promise<void> {
    await this.state.storage.put("pending_otp", { ...pending, attempts: pending.attempts + 1 })
  }
}

function isValidEmail(s: string): boolean {
  // Pragmatic email check; intentionally not RFC-strict.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

/** Split "prefix:payload" once. Payloads themselves may contain colons. */
function splitCallback(data: string): [string, string] {
  const idx = data.indexOf(":")
  if (idx === -1) return [data, ""]
  return [data.slice(0, idx), data.slice(idx + 1)]
}
