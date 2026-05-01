export type Locale = "pt" | "en"

export const DEFAULT_LOCALE: Locale = "pt"

/** Tiny first-message heuristic. We assume PT unless the patient opens in EN. */
export function detectLocaleFromText(text: string): Locale {
  const lower = text.trim().toLowerCase()
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/.test(lower)) return "en"
  return DEFAULT_LOCALE
}

type StringKey =
  | "welcome_unlinked"
  | "invalid_email"
  | "email_not_found"
  | "otp_sent"
  | "otp_invalid"
  | "otp_too_many_attempts"
  | "otp_expired"
  | "registration_incomplete"
  | "welcome_linked"
  | "main_menu_book"
  | "main_menu_my_appts"
  | "main_menu_faq"
  | "feature_in_construction"
  | "reset_state"

const STRINGS: Record<Locale, Record<StringKey, string>> = {
  pt: {
    welcome_unlinked: "Olá! Sou o concierge da EQUAL Care. Para te identificar, qual o teu email?",
    invalid_email: "Esse não parece um email válido. Tenta outra vez.",
    email_not_found: "Não encontrei essa conta. Cria primeiro a conta na app EQUAL Care: {app_url}",
    otp_sent: "Enviei um código de 6 dígitos para o teu email. Cola aqui (sem espaços).",
    otp_invalid: "Código inválido. Tenta outra vez.",
    otp_too_many_attempts: "Demasiadas tentativas. Recomeça com /start ou contacta a clínica.",
    otp_expired: "Esse código já expirou. Recomeça com /start.",
    registration_incomplete: "Para marcar consultas, termina primeiro o registo na app EQUAL Care: {app_url}",
    welcome_linked: "Pronto, {name}. Como posso ajudar?",
    main_menu_book: "Marcar consulta",
    main_menu_my_appts: "As minhas consultas",
    main_menu_faq: "Tenho uma dúvida",
    feature_in_construction: "Funcionalidade em construção. Para já só consigo identificar-te.",
    reset_state: "Conversa reiniciada."
  },
  en: {
    welcome_unlinked: "Hi! I'm the EQUAL Care concierge. To identify you, what's your email?",
    invalid_email: "That doesn't look like a valid email. Try again.",
    email_not_found: "I can't find that account. Sign up first in the EQUAL Care app: {app_url}",
    otp_sent: "I sent a 6-digit code to your email. Paste it here (no spaces).",
    otp_invalid: "Invalid code. Try again.",
    otp_too_many_attempts: "Too many attempts. Restart with /start or contact the clinic.",
    otp_expired: "That code has expired. Restart with /start.",
    registration_incomplete: "To book appointments, finish your registration in the EQUAL Care app first: {app_url}",
    welcome_linked: "Hello {name}. How can I help?",
    main_menu_book: "Book a consultation",
    main_menu_my_appts: "My appointments",
    main_menu_faq: "I have a question",
    feature_in_construction: "Feature under construction. I can only identify you for now.",
    reset_state: "Conversation reset."
  }
}

export function t(locale: Locale, key: StringKey, vars?: Record<string, string>): string {
  let s = STRINGS[locale][key] ?? STRINGS[DEFAULT_LOCALE][key]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, v)
    }
  }
  return s
}
