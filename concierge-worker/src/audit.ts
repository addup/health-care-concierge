import type { Env } from "./env"
import { serviceClient } from "./supabase"
import type { Json } from "../../shared/db-types-concierge"

/**
 * Best-effort audit-log writer. Failures are swallowed: a missing row
 * shouldn't break the patient's conversation.
 *
 * Payload accepts any JSON-serializable shape; the DB column is jsonb.
 * We cast at the boundary instead of forcing every caller to satisfy
 * the recursive `Json` index signature.
 */
export async function logAction(
  env: Env,
  args: {
    patient_id: string | null
    telegram_user_id: number | null
    intent: string | null
    action: string
    payload?: unknown
  }
): Promise<void> {
  try {
    await serviceClient(env).rpc("log_concierge_action", {
      p_patient_id: args.patient_id,
      p_telegram_user_id: args.telegram_user_id,
      p_intent: args.intent,
      p_action: args.action,
      p_payload: (args.payload ?? {}) as Json
    })
  } catch (err) {
    console.error("audit log failed", err)
  }
}
