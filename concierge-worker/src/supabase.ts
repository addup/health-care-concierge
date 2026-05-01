import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "../../shared/db-types-concierge"
import type { Env } from "./env"

export type DB = SupabaseClient<Database>

const noPersistAuth = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
} as const

/**
 * Anon client. Used for the OTP flow (signInWithOtp / verifyOtp) before
 * we have a session.
 */
export function anonClient(env: Env): DB {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, noPersistAuth)
}

/**
 * Service-role client. Bypasses RLS. Used for cross-patient operations:
 * Telegram link upsert, patient lookups for routing, audit log writes,
 * and the scheduler's queries.
 */
export function serviceClient(env: Env): DB {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, noPersistAuth)
}

/**
 * Patient-scoped client. Anon key + the patient's access token, so RLS
 * sees `auth.uid()` as the patient. Used for booking, appointment reads,
 * and any per-patient query.
 */
export function patientClient(env: Env, accessToken: string): DB {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...noPersistAuth,
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  })
}
