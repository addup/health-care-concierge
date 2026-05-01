import type { Env } from "./env"

// Re-export the Durable Object class so wrangler can find it.
export { PatientAgent } from "./patient-agent"

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 })
    }

    if (url.pathname === "/webhook/telegram" && request.method === "POST") {
      // Phase 1 wires this to the PatientAgent DO. For Phase 0 we just ack.
      return new Response("not-implemented", { status: 501 })
    }

    if (url.pathname === "/admin/setup-webhook" && request.method === "POST") {
      // Phase 1 implements this (one-shot Telegram setWebhook).
      return new Response("not-implemented", { status: 501 })
    }

    return new Response("not-found", { status: 404 })
  }
} satisfies ExportedHandler<Env>
