// Bindings injected by wrangler.toml + secrets.
// See ../wrangler.toml and .dev.vars.example for the canonical list.

export interface Env {
  // Durable Object
  PATIENT_AGENT: DurableObjectNamespace

  // Workers AI (used from Phase 2 onwards)
  AI: Ai

  // Vectorize FAQ index
  FAQ_INDEX: VectorizeIndex

  // KV namespace for short-id ↔ uuid mappings
  KV: KVNamespace

  // Secrets
  TELEGRAM_BOT_TOKEN: string
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_KEY: string
}
