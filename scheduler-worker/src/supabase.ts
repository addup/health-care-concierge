import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "../../shared/db-types-concierge"
import type { Env } from "./env"

export type DB = SupabaseClient<Database>

export function serviceClient(env: Env): DB {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
}
