import type { Env } from "./env"
import { sendMessage, sendChatAction } from "./telegram"
import type { Locale } from "./i18n"
import { FAQ_CORPUS, type FaqEntry } from "./faq-corpus"

const EMBEDDING_MODEL = "@cf/baai/bge-m3"
const ANSWER_MODEL = "@cf/meta/llama-3.1-8b-instruct"
const MATCH_THRESHOLD = 0.75
const TOP_K = 3

interface FaqMetadata {
  lang: "pt" | "en"
  question: string
  answer: string
}

/**
 * Answer a free-text FAQ question. Vectorize over the seeded corpus;
 * if the top match is above MATCH_THRESHOLD, return its canned answer
 * verbatim. Otherwise compose a short answer with the small Llama model
 * using the top-3 retrieved entries as context.
 */
export async function faqLookup(
  env: Env,
  chat_id: number,
  query: string,
  locale: Locale
): Promise<void> {
  await sendChatAction(env, chat_id, "typing")

  const vector = await embed(env, query)
  if (!vector) {
    await sendMessage(env, chat_id, fallbackCopy(locale))
    return
  }

  const result = await env.VECTORIZE.query(vector, {
    topK: TOP_K,
    returnMetadata: "all"
    // No language filter — bge-m3 is multilingual; cosine handles cross-lang well.
  })
  const matches = result?.matches ?? []
  const top = matches[0]
  if (top && top.score >= MATCH_THRESHOLD && top.metadata) {
    const meta = top.metadata as unknown as FaqMetadata
    await sendMessage(env, chat_id, meta.answer)
    return
  }

  // Soft fallback: ask the small Llama model to answer using the retrieved
  // entries as grounding. Keep it tight; refuse if no decent context.
  if (matches.length === 0) {
    await sendMessage(env, chat_id, fallbackCopy(locale))
    return
  }
  const composed = await composeAnswer(env, query, locale, matches)
  await sendMessage(env, chat_id, composed ?? fallbackCopy(locale))
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  try {
    const out = (await env.AI.run(EMBEDDING_MODEL as never, { text: [text] } as never)) as {
      data?: number[][]
      shape?: number[]
    }
    return out?.data?.[0] ?? null
  } catch {
    return null
  }
}

async function composeAnswer(
  env: Env,
  query: string,
  locale: Locale,
  matches: { metadata?: unknown; score: number }[]
): Promise<string | null> {
  const context = matches
    .map((m) => m.metadata as unknown as FaqMetadata | undefined)
    .filter((m): m is FaqMetadata => !!m)
    .map((m, i) => `[${i + 1}] Q: ${m.question}\nA: ${m.answer}`)
    .join("\n\n")
  if (!context) return null

  const sys =
    locale === "pt"
      ? "És o concierge da clínica EQUAL Care. Responde curto, em português de Portugal, usando APENAS a informação de contexto. Se não há resposta no contexto, diz que não tens essa informação e sugere falar com a recepção."
      : "You are the EQUAL Care clinic concierge. Reply briefly using ONLY the provided context. If the context doesn't answer, say you don't have that information and suggest contacting reception."

  try {
    const out = (await env.AI.run(ANSWER_MODEL as never, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` }
      ],
      temperature: 0.2,
      max_tokens: 220
    } as never)) as { response?: string }
    const reply = out?.response?.trim()
    return reply && reply.length > 0 ? reply : null
  } catch {
    return null
  }
}

function fallbackCopy(locale: Locale): string {
  return locale === "pt"
    ? "Não tenho essa informação. Tenta perguntar de outra forma ou contacta a recepção da clínica."
    : "I don't have that information. Try rephrasing or contact the clinic's reception."
}

// ---------------------------------------------------------------------
// Seeding (called from /admin/seed-faq)
// ---------------------------------------------------------------------

export async function seedFaqCorpus(env: Env): Promise<{ inserted: number }> {
  const vectors: { id: string; values: number[]; metadata: FaqMetadata }[] = []
  for (const entry of FAQ_CORPUS) {
    const vec = await embed(env, entry.question)
    if (!vec) continue
    vectors.push({
      id: entry.id,
      values: vec,
      metadata: { lang: entry.lang, question: entry.question, answer: entry.answer }
    })
  }
  // Upsert (Vectorize replaces existing by id).
  // The cast bridges our typed FaqMetadata to Vectorize's wide
  // Record<string, VectorizeVectorMetadata> shape — the runtime data
  // is just JSON in the vector index.
  if (vectors.length > 0) {
    await env.VECTORIZE.upsert(vectors as unknown as VectorizeVector[])
  }
  return { inserted: vectors.length }
}

// Re-export for callers that want to inspect the corpus.
export type { FaqEntry }
