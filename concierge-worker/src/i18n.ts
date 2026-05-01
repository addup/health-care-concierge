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
  | "booking_ask_specialty"
  | "booking_no_specialties"
  | "booking_ask_type"
  | "booking_ask_date"
  | "booking_no_types"
  | "booking_ask_slot"
  | "booking_no_slots"
  | "booking_slot_taken"
  | "booking_confirmed"
  | "booking_failed"
  | "date_today"
  | "date_tomorrow"
  | "date_dow_0"
  | "date_dow_1"
  | "date_dow_2"
  | "date_dow_3"
  | "date_dow_4"
  | "date_dow_5"
  | "date_dow_6"
  | "list_empty"
  | "list_header"
  | "appt_line"
  | "manage_pick_appt_reschedule"
  | "manage_pick_appt_cancel"
  | "manage_no_upcoming"
  | "cancel_confirm_prompt"
  | "cancel_confirm_yes"
  | "cancel_confirm_no"
  | "cancel_done"
  | "cancel_kept"
  | "cancel_failed"
  | "reschedule_done"
  | "reschedule_failed"

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
    reset_state: "Conversa reiniciada.",
    booking_ask_specialty: "Que especialidade?",
    booking_no_specialties: "Não há especialidades activas neste momento. Tenta mais tarde.",
    booking_ask_type: "Que tipo de consulta?",
    booking_ask_date: "Para que dia?",
    booking_no_types: "Não há tipos de consulta disponíveis para essa especialidade. Tenta outra.",
    booking_ask_slot: "Horários disponíveis em {date}:",
    booking_no_slots: "Sem horários disponíveis em {date}. Escolhe outro dia.",
    booking_slot_taken: "Esse horário foi entretanto ocupado. Vou voltar a procurar.",
    booking_confirmed: "✅ Marcado: {type} com {doctor}, {when}. Recebes um lembrete 24h antes.",
    booking_failed: "Não consegui marcar agora. Tenta outra vez ou contacta a clínica.",
    date_today: "Hoje",
    date_tomorrow: "Amanhã",
    date_dow_0: "Dom",
    date_dow_1: "Seg",
    date_dow_2: "Ter",
    date_dow_3: "Qua",
    date_dow_4: "Qui",
    date_dow_5: "Sex",
    date_dow_6: "Sáb",
    list_empty: "Não tens consultas marcadas.",
    list_header: "As tuas consultas:",
    appt_line: "• {when} — {type} com {doctor}",
    manage_pick_appt_reschedule: "Qual consulta queres reagendar?",
    manage_pick_appt_cancel: "Qual consulta queres cancelar?",
    manage_no_upcoming: "Não tens consultas futuras para gerir.",
    cancel_confirm_prompt: "Cancelar {when} — {type}?",
    cancel_confirm_yes: "Sim, cancelar",
    cancel_confirm_no: "Não, manter",
    cancel_done: "✅ Consulta cancelada.",
    cancel_kept: "Mantive a consulta.",
    cancel_failed: "Não consegui cancelar agora. Tenta outra vez.",
    reschedule_done: "✅ Reagendado para {when}.",
    reschedule_failed: "Não consegui reagendar agora. Tenta outra vez."
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
    reset_state: "Conversation reset.",
    booking_ask_specialty: "Which specialty?",
    booking_no_specialties: "No active specialties right now. Try later.",
    booking_ask_type: "What kind of appointment?",
    booking_ask_date: "What day?",
    booking_no_types: "No appointment types available for that specialty. Pick another.",
    booking_ask_slot: "Available slots on {date}:",
    booking_no_slots: "No available slots on {date}. Pick another day.",
    booking_slot_taken: "That slot was just taken. Let me look again.",
    booking_confirmed: "✅ Booked: {type} with {doctor}, {when}. You'll get a reminder 24h before.",
    booking_failed: "I couldn't complete the booking right now. Try again or call the clinic.",
    date_today: "Today",
    date_tomorrow: "Tomorrow",
    date_dow_0: "Sun",
    date_dow_1: "Mon",
    date_dow_2: "Tue",
    date_dow_3: "Wed",
    date_dow_4: "Thu",
    date_dow_5: "Fri",
    date_dow_6: "Sat",
    list_empty: "You have no upcoming appointments.",
    list_header: "Your appointments:",
    appt_line: "• {when} — {type} with {doctor}",
    manage_pick_appt_reschedule: "Which appointment do you want to reschedule?",
    manage_pick_appt_cancel: "Which appointment do you want to cancel?",
    manage_no_upcoming: "You have no upcoming appointments to manage.",
    cancel_confirm_prompt: "Cancel {when} — {type}?",
    cancel_confirm_yes: "Yes, cancel",
    cancel_confirm_no: "No, keep it",
    cancel_done: "✅ Appointment cancelled.",
    cancel_kept: "I kept the appointment.",
    cancel_failed: "I couldn't cancel right now. Try again.",
    reschedule_done: "✅ Rescheduled to {when}.",
    reschedule_failed: "I couldn't reschedule right now. Try again."
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
