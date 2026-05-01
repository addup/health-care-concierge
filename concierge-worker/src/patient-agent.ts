import type { Env } from "./env"

/**
 * Per-patient Durable Object. Holds conversational state across turns.
 *
 * Phase 0: skeleton only — accepts any fetch and returns 200. Phase 1
 * implements the /start + OTP flow; later phases add intent routing,
 * triage, booking, and form runner.
 *
 * State keys (added across phases, see docs/concierge/02-tech-spec.md §2.2):
 *   auth, pending_otp, intent_state, triage_state, form_state,
 *   last_message_at, locale
 */
export class PatientAgent implements DurableObject {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, phase: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }
}
