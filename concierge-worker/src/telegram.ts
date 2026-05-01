import type { Env } from "./env"

const TG_API = "https://api.telegram.org"

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
  language_code?: string
}

export interface TelegramChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

export interface ReplyMarkup {
  inline_keyboard?: InlineKeyboardButton[][]
}

interface TgResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

async function tgRequest<T>(env: Env, method: string, payload: unknown): Promise<T> {
  const url = `${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })
  const data = (await res.json()) as TgResponse<T>
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`)
  return data.result as T
}

export async function sendMessage(
  env: Env,
  chat_id: number,
  text: string,
  reply_markup?: ReplyMarkup
): Promise<void> {
  // No parse_mode by default — agent / LLM-generated text occasionally
  // contains literal '<' / '>' or '*' that would break HTML or Markdown
  // parsing. Plain text is safe; we don't actually need formatting.
  await tgRequest(env, "sendMessage", {
    chat_id,
    text,
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {})
  })
}

export async function sendChatAction(env: Env, chat_id: number, action: "typing"): Promise<void> {
  // Don't fail the whole turn if typing indicator fails.
  try {
    await tgRequest(env, "sendChatAction", { chat_id, action })
  } catch {
    /* swallow */
  }
}

export async function answerCallbackQuery(
  env: Env,
  callback_query_id: string,
  text?: string
): Promise<void> {
  try {
    await tgRequest(env, "answerCallbackQuery", { callback_query_id, ...(text ? { text } : {}) })
  } catch {
    /* swallow */
  }
}

export async function setWebhook(
  env: Env,
  url: string,
  secret_token?: string
): Promise<unknown> {
  return tgRequest(env, "setWebhook", {
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
    ...(secret_token ? { secret_token } : {})
  })
}
