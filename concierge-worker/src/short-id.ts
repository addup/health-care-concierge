import type { Env } from "./env"

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-"
const KV_PREFIX = "short:"
const DEFAULT_TTL_SECONDS = 30 * 60

/**
 * 10-character URL-safe ID. 64^10 ≈ 1.15e18 — plenty for booking
 * sessions, no collision worry within the 30-min TTL window.
 */
export function nanoid10(): string {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    out += ALPHABET[bytes[i]! & 63]
  }
  return out
}

/**
 * Stash a JSON-serialisable value behind a 10-char short ID. Used to
 * pack things bigger than Telegram's 64-byte callback_data budget.
 */
export async function putShortId(
  env: Env,
  value: unknown,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
  const id = nanoid10()
  await env.CONCIERGE_KV.put(`${KV_PREFIX}${id}`, JSON.stringify(value), {
    expirationTtl: ttlSeconds
  })
  return id
}

export async function getShortId<T = unknown>(env: Env, id: string): Promise<T | null> {
  const raw = await env.CONCIERGE_KV.get(`${KV_PREFIX}${id}`)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
