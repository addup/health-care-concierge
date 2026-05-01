/**
 * Tiny scheduler-side string table. The bigger i18n module lives in
 * concierge-worker; the scheduler only needs reminder copy.
 */
export type Locale = "pt" | "en"

export function reminder24hText(locale: Locale, args: {
  hhmm: string
  type: string
  doctor: string
}): string {
  if (locale === "en") {
    return `Reminder: tomorrow at ${args.hhmm}, ${args.type} with ${args.doctor}. Reply /start to manage.`
  }
  return `Lembrete: amanhã às ${args.hhmm}, ${args.type}${args.doctor ? ` com ${args.doctor}` : ""}. Envia /start para gerir.`
}
