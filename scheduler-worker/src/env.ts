// Bindings injected by wrangler.toml + secrets.

export interface Env {
  // Service binding back into concierge-worker (push to a DO via fetch).
  CONCIERGE: Fetcher

  // Secrets
  TELEGRAM_BOT_TOKEN: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
  ADMIN_SECRET: string
}
