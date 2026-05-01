import type { Env } from "./env"

export interface DispatchPayload {
  type: "form_dispatch" | "reminder"
  patient_id: string
  dispatch_id?: string
  text?: string
}

/**
 * Service-binding call into concierge-worker. The concierge looks up
 * the patient's chat id and forwards to the right PatientAgent DO.
 */
export async function pushToConcierge(env: Env, payload: DispatchPayload): Promise<boolean> {
  try {
    const res = await env.CONCIERGE.fetch("https://concierge.local/internal/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      console.error("pushToConcierge non-ok", res.status, await res.text())
      return false
    }
    const body = (await res.json()) as { ok?: boolean }
    return !!body.ok
  } catch (err) {
    console.error("pushToConcierge error", err)
    return false
  }
}
