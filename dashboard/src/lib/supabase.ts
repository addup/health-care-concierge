import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@shared/db-types-concierge"

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_SERVICE_KEY as string | undefined

if (!url || !key) {
  // Surface a clear error during dev rather than later at query time.
  // eslint-disable-next-line no-console
  console.warn(
    "Dashboard: VITE_SUPABASE_URL and/or VITE_SUPABASE_SERVICE_KEY are not set. " +
    "Copy .env.local.example to .env.local and fill them in."
  )
}

export const supabase: SupabaseClient<Database> = createClient<Database>(
  url ?? "",
  key ?? "",
  {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  }
)
