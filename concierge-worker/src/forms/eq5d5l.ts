/**
 * EQ-5D-5L scoring wrapper. Question ids match the seed:
 *   mobility, self_care, usual_activities, pain_discomfort,
 *   anxiety_depression (each likert5_inverse 1..5),
 *   vas (vas 0..100 step 10).
 */
import { buildProfile, scoreProfile, valueSetForLocale } from "../../../shared/eq5d5l-scoring"
import type { Locale } from "./types"

export interface Eq5d5lScore {
  profile: string
  eq5d_index: number
  vas: number
}

export function scoreEQ5D5L(answers: Record<string, number | string>, locale: Locale): Eq5d5lScore {
  const profile = buildProfile({
    mobility: toInt(answers.mobility),
    self_care: toInt(answers.self_care),
    usual_activities: toInt(answers.usual_activities),
    pain_discomfort: toInt(answers.pain_discomfort),
    anxiety_depression: toInt(answers.anxiety_depression)
  })
  return {
    profile,
    eq5d_index: scoreProfile(profile, valueSetForLocale(locale)),
    vas: toInt(answers.vas)
  }
}

function toInt(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v)
  if (typeof v === "string") {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
