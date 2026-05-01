// Bindings injected by wrangler.toml + secrets.

export interface Env {
  // Durable Object
  PATIENT_AGENT: DurableObjectNamespace

  // Workers AI (used from Phase 2)
  AI: Ai

  // Vectorize FAQ index
  FAQ_INDEX: VectorizeIndex

  // KV namespace for short-id ↔ uuid mappings
  KV: KVNamespace

  // Non-secret vars (wrangler.toml [vars])
  PLATFORM_APP_URL: string

  // Secrets (wrangler secret put / .dev.vars)
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET?: string  // optional; if set, x-telegram-bot-api-secret-token must match
  ADMIN_SECRET?: string             // gates /admin/setup-webhook
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_KEY: string
}
