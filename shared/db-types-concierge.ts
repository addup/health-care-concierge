/**
 * Concierge-side extension of the platform's auto-generated DB types.
 * Re-derive `Database` so that supabase-js gets typed access to our
 * `concierge_*` RPCs without having to regenerate the platform types
 * file every time we add a new RPC here.
 *
 * When/if we ever run `supabase gen types` against the merged schema,
 * this file becomes superfluous.
 */
import type { Database as PlatformDatabase, Json } from "./db-types"

type Public = PlatformDatabase["public"]

type ConciergeFunctions = {
  concierge_link_telegram: {
    Args: { p_telegram_user_id: number; p_patient_id: string; p_locale?: string }
    Returns: undefined
  }
  concierge_unlink_telegram: {
    Args: { p_telegram_user_id: number }
    Returns: undefined
  }
  concierge_lookup_patient_by_telegram: {
    Args: { p_telegram_user_id: number }
    Returns: { patient_id: string; locale: string }[]
  }
  dispatch_concierge_form: {
    Args: {
      p_id: string
      p_appointment_id: string
      p_template_id: string
      p_schedule_label: string
      p_scheduled_for: string
    }
    Returns: undefined
  }
  mark_concierge_form_sent: {
    Args: { p_dispatch_id: string; p_is_reminder?: boolean }
    Returns: undefined
  }
  record_concierge_form_response: {
    Args: { p_dispatch_id: string; p_answers: Json; p_score: Json }
    Returns: undefined
  }
  abandon_stale_concierge_dispatches: {
    Args: Record<string, never>
    Returns: number
  }
  log_concierge_action: {
    Args: {
      p_patient_id: string | null
      p_telegram_user_id: number | null
      p_intent: string | null
      p_action: string
      p_payload?: Json
    }
    Returns: undefined
  }
  concierge_set_appointment_state: {
    Args: { p_appointment_id: string; p_field: string; p_value: string }
    Returns: undefined
  }
  demo_force_concierge_dispatch_all_due: {
    Args: Record<string, never>
    Returns: number
  }
}

export type Database = Omit<PlatformDatabase, "public"> & {
  public: Omit<Public, "Functions"> & {
    Functions: Public["Functions"] & ConciergeFunctions
  }
}

export type { Json }
